from collections import defaultdict

from django.core.exceptions import ObjectDoesNotExist

from dcim.models import Device, Rack
from netbox.plugins import get_plugin_config

from .models import RoomLayout

PLUGIN = 'netbox_room_view'

# Default outer width (mm) by rail width (inches) when a rack has no outer width set
DEFAULT_RACK_WIDTH = {10: 300, 19: 600, 21: 600, 23: 800}
MM_PER_UNIT = {'mm': 1, 'in': 25.4}


def default_layout(location):
    """An unsaved RoomLayout with the configured defaults."""
    return RoomLayout(
        location=location,
        columns=get_plugin_config(PLUGIN, 'default_columns'),
        rows=get_plugin_config(PLUGIN, 'default_rows'),
        tile_size=get_plugin_config(PLUGIN, 'tile_size'),
    )


def get_layout(location):
    try:
        return location.room_layout
    except RoomLayout.DoesNotExist:
        return default_layout(location)


def rack_footprint(rack):
    """Outer (width, depth) of a rack in millimetres."""
    factor = MM_PER_UNIT.get(rack.outer_unit or 'mm', 1)
    width = rack.outer_width * factor if rack.outer_width else DEFAULT_RACK_WIDTH.get(rack.width, 600)
    depth = rack.outer_depth * factor if rack.outer_depth else get_plugin_config(PLUGIN, 'default_rack_depth')
    return round(width), round(depth)


def footprint_rect(x, y, rotation, width, depth, tile):
    """(x0, y0, x1, y1) in millimetres for a rack placed at tile x,y."""
    if rotation in (90, 270):
        width, depth = depth, width
    x0, y0 = x * tile, y * tile
    return x0, y0, x0 + width, y0 + depth


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def placement_error(layout, rack, x, y, rotation):
    """Why a rack can't stand at x,y with this rotation, or None if it can."""
    tile = layout.tile_size
    rect = footprint_rect(x, y, rotation, *rack_footprint(rack), tile)
    if x < 0 or y < 0 or rect[2] > layout.columns * tile or rect[3] > layout.rows * tile:
        return f'{rack.name} would extend past the edge of the room.'
    if layout.pk:
        for other in layout.placements.exclude(rack=rack).select_related('rack'):
            other_rect = footprint_rect(other.x, other.y, other.rotation, *rack_footprint(other.rack), tile)
            if overlaps(rect, other_rect):
                return f'{rack.name} would overlap {other.rack.name}.'
    return None


def in_device_bay(device):
    """True for child devices installed in another device's bay; they can't be racked."""
    try:
        return device.parent_bay is not None
    except ObjectDoesNotExist:
        return False


def _color(value):
    return f'#{value}' if value else None


def room_payload(location, user):
    """Everything the Room View page needs to draw a comms room."""
    layout = get_layout(location)
    racks = (
        Rack.objects.restrict(user, 'view')
        .filter(location=location)
        .select_related('role', 'tenant', 'room_placement__layout')
        .order_by('name')
    )
    devices = (
        Device.objects.restrict(user, 'view')
        .filter(location=location)
        .select_related('device_type__manufacturer', 'role', 'tenant', 'parent_bay__device')
    )

    search_terms = defaultdict(list)
    device_counts = defaultdict(int)
    # [position, height, colour, face] per racked device, for the 3D view.
    # Face is "f" or "r", or "b" for full-depth devices seen from both sides.
    rack_units = defaultdict(list)
    unracked = []
    for device in devices:
        if device.rack_id and device.position is not None:
            device_counts[device.rack_id] += 1
            rack_units[device.rack_id].append([
                float(device.position), float(device.device_type.u_height), _color(device.role.color),
                'b' if device.device_type.is_full_depth else (device.face or 'front')[0],
            ])
            search_terms[device.rack_id].extend(
                v for v in (device.name, device.serial, device.asset_tag, device.device_type.model) if v
            )
        elif device.device_type.u_height > 0 and not in_device_bay(device):
            unracked.append(_device_dict(device))

    rack_list = []
    for rack in racks:
        width, depth = rack_footprint(rack)
        placement = getattr(rack, 'room_placement', None)
        # A placement saved in another room no longer applies here
        if placement is not None and placement.layout.location_id != location.pk:
            placement = None
        power = rack.get_power_utilization()
        rack_list.append({
            'id': rack.pk,
            'name': rack.name,
            'facility_id': rack.facility_id or '',
            'url': rack.get_absolute_url(),
            'status': rack.get_status_display(),
            'status_color': rack.get_status_color(),
            'role': rack.role.name if rack.role else '',
            'role_color': _color(rack.role.color) if rack.role else None,
            'tenant': rack.tenant.name if rack.tenant else '',
            'u_height': rack.u_height,
            'starting_unit': rack.starting_unit,
            'desc_units': rack.desc_units,
            'units': rack_units[rack.pk],
            'space': round(rack.get_utilization(), 1),
            'power': power if rack.powerfeeds.exists() else None,
            'devices': device_counts[rack.pk],
            'width_mm': width,
            'depth_mm': depth,
            'placed': placement is not None,
            'x': placement.x if placement else None,
            'y': placement.y if placement else None,
            'rotation': placement.rotation if placement else 0,
            'search': ' '.join([rack.name, rack.facility_id or ''] + search_terms[rack.pk]).lower(),
        })

    objects = []
    if layout.pk:
        objects = [
            {
                'id': o.pk, 'kind': o.kind, 'kind_label': o.get_kind_display(), 'label': o.label,
                'x': o.x, 'y': o.y, 'width': o.width, 'height': o.height,
            }
            for o in layout.floor_objects.all()
        ]

    return {
        'room': {'id': location.pk, 'name': location.name, 'site': location.site.name},
        'layout': {'columns': layout.columns, 'rows': layout.rows, 'tile': layout.tile_size},
        'racks': rack_list,
        'objects': objects,
        'unracked': sorted(unracked, key=lambda d: d['name'].lower()),
        'perms': {
            'edit_layout': user.has_perms(['dcim.change_rack', 'dcim.change_location']),
            'move_devices': user.has_perm('dcim.change_device'),
        },
    }


def _device_dict(device):
    return {
        'id': device.pk,
        'name': device.name or str(device),
        'url': device.get_absolute_url(),
        'type': device.device_type.model,
        'manufacturer': device.device_type.manufacturer.name,
        'role': device.role.name,
        'role_color': _color(device.role.color),
        'height': float(device.device_type.u_height),
        'full_depth': device.device_type.is_full_depth,
        'position': float(device.position) if device.position is not None else None,
        'face': device.face or '',
        'status': device.get_status_display(),
        'status_color': device.get_status_color(),
        'serial': device.serial,
        'asset_tag': device.asset_tag or '',
        'tenant': device.tenant.name if device.tenant else '',
    }


def rack_payload(rack, user):
    """Elevation data for one rack."""
    devices = (
        Device.objects.restrict(user, 'view')
        .filter(rack=rack, position__isnull=False)
        .select_related('device_type__manufacturer', 'role', 'tenant')
        .order_by('-position')
    )
    reserved = sorted({int(u) for u in rack.get_reserved_units()})
    return {
        'id': rack.pk,
        'name': rack.name,
        'url': rack.get_absolute_url(),
        'u_height': rack.u_height,
        'starting_unit': rack.starting_unit,
        'desc_units': rack.desc_units,
        'reserved': reserved,
        'devices': [_device_dict(d) for d in devices],
    }

import json
from decimal import Decimal, InvalidOperation

from django.contrib.auth.mixins import LoginRequiredMixin
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import Count
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, render
from django.urls import reverse
from django.views import View

from dcim.models import Device, Location, Rack
from netbox.views import generic
from utilities.views import ViewTab, register_model_view

from .models import RackPlacement, RoomLayout, RoomObject
from .utils import (
    footprint_rect, get_layout, in_device_bay, placement_error, rack_footprint, rack_payload, room_payload,
)


def _units(value):
    """Rack units for messages: 2 rather than 2.0, but 1.5 stays 1.5."""
    return int(value) if value == int(value) else float(value)


def _api_root():
    return reverse('plugins:netbox_room_view:room_list') + 'api/'


@register_model_view(Location, 'roomview', path='room-view')
class LocationRoomView(generic.ObjectView):
    """Floor plan tab on a Location."""
    queryset = Location.objects.all()
    template_name = 'netbox_room_view/room.html'
    tab = ViewTab(
        label='Room View',
        badge=lambda obj: obj.racks.count(),
        hide_if_empty=True,
        permission='dcim.view_rack',
        weight=450,
    )

    def get_extra_context(self, request, instance):
        return {
            'payload': room_payload(instance, request.user),
            'api_root': _api_root(),
        }


class RoomListView(LoginRequiredMixin, View):
    """All locations that contain racks, i.e. the comms rooms."""

    def get(self, request):
        rooms = (
            Location.objects.restrict(request.user, 'view')
            .annotate(rack_count=Count('racks', distinct=True))
            .filter(rack_count__gt=0)
            .select_related('site', 'parent')
            .order_by('site__name', 'name')
        )
        device_counts = dict(
            Device.objects.restrict(request.user, 'view')
            .filter(location__in=rooms, rack__isnull=False)
            .values_list('location').annotate(n=Count('pk')).values_list('location', 'n')
        )
        placed_counts = dict(
            RackPlacement.objects.filter(layout__location__in=rooms)
            .values_list('layout__location').annotate(n=Count('pk')).values_list('layout__location', 'n')
        )
        rows = [
            {
                'location': room,
                'url': reverse('dcim:location_roomview', kwargs={'pk': room.pk}),
                'racks': room.rack_count,
                'devices': device_counts.get(room.pk, 0),
                'placed': placed_counts.get(room.pk, 0),
            }
            for room in rooms
        ]
        return render(request, 'netbox_room_view/room_list.html', {'rows': rows})


class _ApiView(LoginRequiredMixin, View):
    """JSON endpoint; errors are returned as {"error": "..."}."""

    def dispatch(self, request, *args, **kwargs):
        try:
            return super().dispatch(request, *args, **kwargs)
        except PermissionDenied as e:
            return JsonResponse({'error': str(e) or 'Permission denied.'}, status=403)
        except ValidationError as e:
            return JsonResponse({'error': ' '.join(e.messages)}, status=400)

    def handle_no_permission(self):
        return JsonResponse({'error': 'Log in to continue.'}, status=401)

    @staticmethod
    def body(request):
        try:
            return json.loads(request.body or b'{}')
        except ValueError:
            raise ValidationError('Invalid JSON.')

    @staticmethod
    def integer(data, key, minimum=0):
        try:
            value = int(data.get(key))
        except (TypeError, ValueError):
            raise ValidationError(f'"{key}" must be a whole number.')
        if value < minimum:
            raise ValidationError(f'"{key}" must be at least {minimum}.')
        return value

    def editable_room(self, request, pk):
        """The location being edited, checking the user may change it and its racks."""
        if not request.user.has_perms(['dcim.change_rack', 'dcim.change_location']):
            raise PermissionDenied('You need permission to change racks and locations to edit the floor plan.')
        location = get_object_or_404(Location.objects.restrict(request.user, 'change'), pk=pk)
        layout = get_layout(location)
        if layout.pk is None:
            layout.save()
        return location, layout

    def room_response(self, request, location):
        return JsonResponse({'room': room_payload(location, request.user)})


class RoomApiView(_ApiView):
    def get(self, request, pk):
        location = get_object_or_404(Location.objects.restrict(request.user, 'view'), pk=pk)
        return self.room_response(request, location)


class LayoutApiView(_ApiView):
    """Resize the room."""

    def post(self, request, pk):
        data = self.body(request)
        columns = self.integer(data, 'columns', 1)
        rows = self.integer(data, 'rows', 1)
        if columns > 200 or rows > 200:
            raise ValidationError('A room can be at most 200 x 200 tiles.')

        with transaction.atomic():
            location, layout = self.editable_room(request, pk)
            layout.columns, layout.rows = columns, rows
            tile = layout.tile_size
            for p in layout.placements.select_related('rack'):
                rect = footprint_rect(p.x, p.y, p.rotation, *rack_footprint(p.rack), tile)
                if rect[2] > columns * tile or rect[3] > rows * tile:
                    raise ValidationError(f'{p.rack.name} would be outside the room. Move it first.')
            for o in layout.floor_objects.all():
                if o.x + o.width > columns or o.y + o.height > rows:
                    raise ValidationError(f'"{o}" would be outside the room. Move it first.')
            layout.save()
        return self.room_response(request, location)


class PlacementApiView(_ApiView):
    """Place, move, rotate or remove a rack on the floor."""

    def post(self, request, pk):
        data = self.body(request)
        with transaction.atomic():
            location, layout = self.editable_room(request, pk)
            rack = get_object_or_404(
                Rack.objects.restrict(request.user, 'change').filter(location=location),
                pk=self.integer(data, 'rack', 1),
            )
            if data.get('remove'):
                RackPlacement.objects.filter(rack=rack).delete()
                return self.room_response(request, location)

            x, y = self.integer(data, 'x'), self.integer(data, 'y')
            rotation = self.integer(data, 'rotation')
            if rotation not in (0, 90, 180, 270):
                raise ValidationError('Rotation must be 0, 90, 180 or 270.')
            error = placement_error(layout, rack, x, y, rotation)
            if error:
                raise ValidationError(error)
            RackPlacement.objects.update_or_create(
                rack=rack, defaults={'layout': layout, 'x': x, 'y': y, 'rotation': rotation},
            )
        return self.room_response(request, location)


class ObjectApiView(_ApiView):
    """Create, update or delete aisles, cooling units and other floor objects."""

    def post(self, request, pk):
        data = self.body(request)
        with transaction.atomic():
            location, layout = self.editable_room(request, pk)
            obj = None
            if data.get('id'):
                obj = get_object_or_404(RoomObject, pk=self.integer(data, 'id', 1), layout=layout)
                if data.get('remove'):
                    obj.delete()
                    return self.room_response(request, location)
            else:
                obj = RoomObject(layout=layout)

            kind = data.get('kind', obj.kind)
            if kind not in dict(RoomObject.KINDS):
                raise ValidationError('Unknown object type.')
            obj.kind = kind
            obj.label = str(data.get('label', obj.label or ''))[:50]
            for field, minimum in (('x', 0), ('y', 0), ('width', 1), ('height', 1)):
                if field in data or getattr(obj, field) is None:
                    setattr(obj, field, self.integer(data, field, minimum))
            if obj.x + obj.width > layout.columns or obj.y + obj.height > layout.rows:
                raise ValidationError('The object would extend past the edge of the room.')
            obj.full_clean()
            obj.save()
        return self.room_response(request, location)


class RackApiView(_ApiView):
    """Elevation data for one rack."""

    def get(self, request, pk):
        rack = get_object_or_404(Rack.objects.restrict(request.user, 'view'), pk=pk)
        return JsonResponse({'rack': rack_payload(rack, request.user)})


class DeviceMoveApiView(_ApiView):
    """
    Move a device to a rack position, or take it out of its rack.
    Body: {"room": <location id>, "rack": <id or null>, "position": <U or null>, "face": "front"|"rear"}
    A null position picks the device's current U if free, otherwise the highest free one.
    """

    def post(self, request, pk):
        data = self.body(request)
        if not request.user.has_perm('dcim.change_device'):
            raise PermissionDenied('You need permission to change devices to move them.')
        device = get_object_or_404(
            Device.objects.restrict(request.user, 'change').select_related('device_type', 'rack'), pk=pk,
        )
        room = get_object_or_404(Location.objects.restrict(request.user, 'view'), pk=self.integer(data, 'room', 1))
        if in_device_bay(device):
            raise ValidationError(f'{device} is installed in a device bay and cannot be racked.')
        height = device.device_type.u_height
        if not height:
            raise ValidationError(f'{device} is a 0U device and has no rack position.')

        device.snapshot()
        if data.get('rack') is None:
            device.position = None
            device.face = ''
            device.rack = None
        else:
            rack = get_object_or_404(Rack.objects.restrict(request.user, 'view'), pk=self.integer(data, 'rack', 1))
            if rack.site_id != device.site_id:
                raise ValidationError(f'{rack.name} is in a different site from {device}.')
            face = data.get('face') or device.face or 'front'
            if face not in ('front', 'rear'):
                raise ValidationError('Face must be "front" or "rear".')
            position = self.position(data, device, rack, face, height)
            device.rack, device.location = rack, rack.location
            device.position, device.face = position, face

        with transaction.atomic():
            device.full_clean()
            device.save()
            # Enforce object-level permission constraints on the result, as core views do
            if not Device.objects.restrict(request.user, 'change').filter(pk=device.pk).exists():
                raise PermissionDenied('A permission constraint prevents this move.')
        return self.room_response(request, room)

    def position(self, data, device, rack, face, height):
        free = rack.get_available_units(
            u_height=height,
            rack_face=None if device.device_type.is_full_depth else face,
            exclude=[device.pk],
        )
        if data.get('position') is not None:
            try:
                position = Decimal(str(data['position']))
            except InvalidOperation:
                raise ValidationError('Position must be a number.')
            if position not in free:
                raise ValidationError(f'U{_units(position)} in {rack.name} does not have {_units(height)}U free.')
            return position

        whole = [u for u in free if u == int(u)]
        if not whole:
            raise ValidationError(f'{rack.name} has no free space for a {_units(height)}U device.')
        if device.rack_id == rack.pk and device.position in whole:
            return device.position
        return min(whole) if rack.desc_units else max(whole)

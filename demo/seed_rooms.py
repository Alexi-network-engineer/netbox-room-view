# Sample sites, comms rooms, racks, devices and power for trying out Room View.
# Run inside NetBox (see demo/README.md). Skips everything if it has already run.
import random

from django.contrib.auth import get_user_model
from django.contrib.contenttypes.models import ContentType

from dcim.models import (
    Cable, Device, DeviceRole, DeviceType, Location, Manufacturer, PowerFeed, PowerOutletTemplate, PowerPanel,
    PowerPortTemplate, Rack, RackReservation, RackRole, Region, Site,
)
from tenancy.models import Tenant
from netbox_room_view.models import RackPlacement, RoomLayout, RoomObject

if Site.objects.filter(slug='mel-dc').exists():
    print('Room View demo data already exists; nothing to do.')
    raise SystemExit

rng = random.Random(42)
admin = get_user_model().objects.get(username='admin')


def slug(text):
    return ''.join(c if c.isalnum() else '-' for c in text.lower()).strip('-')


# ------------------------------------------------------------------ catalogue

def manufacturer(name):
    return Manufacturer.objects.get_or_create(name=name, slug=slug(name))[0]


TYPES = {}


def device_type(key, make, model, u, full_depth, draw=0, max_draw=None):
    dt, _ = DeviceType.objects.get_or_create(
        manufacturer=manufacturer(make), model=model,
        defaults={'slug': slug(model), 'u_height': u, 'is_full_depth': full_depth},
    )
    if draw and not dt.powerporttemplates.exists():
        PowerPortTemplate.objects.create(
            device_type=dt, name='PSU1', allocated_draw=draw, maximum_draw=max_draw or round(draw * 1.6),
        )
    TYPES[key] = dt


device_type('c9300', 'Cisco', 'Catalyst C9300-48P', 1, False, 350)
device_type('c9500', 'Cisco', 'Catalyst C9500-48Y4C', 1, False, 400)
device_type('n93180', 'Cisco', 'Nexus 93180YC-FX', 1, True, 250)
device_type('asr', 'Cisco', 'ASR 1001-X', 1, True, 200)
device_type('pa3220', 'Palo Alto', 'PA-3220', 1, True, 220)
device_type('r650', 'Dell', 'PowerEdge R650', 1, True, 300)
device_type('r750', 'Dell', 'PowerEdge R750', 2, True, 450)
device_type('dl380', 'HPE', 'ProLiant DL380 Gen11', 2, True, 400)
device_type('synergy', 'HPE', 'Synergy 12000 Frame', 10, True, 2200)
device_type('a400', 'NetApp', 'AFF A400', 4, True, 700)
device_type('ups', 'APC', 'Smart-UPS SMT3000RMI2U', 2, True)
device_type('pp24', 'Panduit', 'Cat6A 24-Port Patch Panel', 1, False)
device_type('fpp', 'Panduit', '1U Fibre Enclosure', 1, False)
device_type('cm', 'Panduit', '1U Horizontal Cable Manager', 1, False)

pdu_type, created = DeviceType.objects.get_or_create(
    manufacturer=manufacturer('APC'), model='AP8853 Rack PDU',
    defaults={'slug': 'ap8853-rack-pdu', 'u_height': 0, 'is_full_depth': False},
)
if created:
    inlet = PowerPortTemplate.objects.create(device_type=pdu_type, name='Inlet')
    for i in range(1, 25):
        PowerOutletTemplate.objects.create(device_type=pdu_type, name=f'Outlet {i:02d}', power_port=inlet)

ROLES = {}
for key, name, color in [
    ('core', 'Core Switch', '3f51b5'), ('access', 'Access Switch', '2196f3'), ('router', 'Router', '9c27b0'),
    ('fw', 'Firewall', 'f44336'), ('server', 'Server', '4caf50'), ('storage', 'Storage', 'ff9800'),
    ('ups', 'UPS', '795548'), ('patch', 'Patch Panel', '9e9e9e'), ('cable', 'Cable Management', '607d8b'),
    ('pdu', 'PDU', '455a64'), ('blade', 'Blade Chassis', '009688'),
]:
    ROLES[key] = DeviceRole.objects.get_or_create(name=name, defaults={'slug': slug(name), 'color': color})[0]

RACK_ROLES = {}
for key, name, color in [
    ('network', 'Network', '2196f3'), ('compute', 'Compute', '4caf50'),
    ('storage', 'Storage', 'ff9800'), ('comms', 'Comms', '9e9e9e'),
]:
    RACK_ROLES[key] = RackRole.objects.get_or_create(name=name, defaults={'slug': slug(name), 'color': color})[0]

TENANTS = {
    name: Tenant.objects.get_or_create(name=name, defaults={'slug': slug(name)})[0]
    for name in ('Infrastructure', 'Finance', 'Engineering', 'Shared Services')
}

ROLE_CODES = {
    'core': 'CORE', 'access': 'SW', 'router': 'RTR', 'fw': 'FW', 'server': 'SRV', 'storage': 'STG',
    'ups': 'UPS', 'blade': 'BLD',
}
counters = {}


def device_name(site_code, role):
    code = ROLE_CODES.get(role)
    if not code:
        return None
    counters[(site_code, code)] = counters.get((site_code, code), 0) + 1
    return f'{site_code}-{code}-{counters[(site_code, code)]:03d}'


# ------------------------------------------------------------------ rack contents

def network_plan():
    return [
        ('pp24', 'patch', 42), ('pp24', 'patch', 41), ('cm', 'cable', 40), ('n93180', 'core', 39),
        ('n93180', 'core', 38), ('cm', 'cable', 37), ('c9500', 'core', 36), ('c9500', 'core', 35),
        ('asr', 'router', 33), ('asr', 'router', 32), ('pa3220', 'fw', 30), ('pa3220', 'fw', 29),
        ('fpp', 'patch', 42, 'rear'), ('fpp', 'patch', 41, 'rear'), ('ups', 'ups', 1),
    ]


def access_plan(switches=3):
    plan = []
    u = 42
    for _ in range(switches):
        plan += [('pp24', 'patch', u), ('c9300', 'access', u - 1), ('cm', 'cable', u - 2)]
        u -= 3
    return plan + [('fpp', 'patch', 42, 'rear'), ('ups', 'ups', 1)]


def compute_plan(fill):
    """Top-of-rack switch and patch panel, then servers from U1 up to roughly `fill` of the rack."""
    plan = [('n93180', 'core', 42), ('pp24', 'patch', 41)]
    u, limit = 1, max(2, round(40 * fill))
    while True:
        key = rng.choice(['r650', 'r650', 'r750', 'dl380'])
        height = TYPES[key].u_height
        if u + height - 1 > limit:
            break
        plan.append((key, 'server', u))
        u += height
    return plan


def storage_plan(shelves):
    return [('n93180', 'core', 42), ('pp24', 'patch', 41)] + [('a400', 'storage', 1 + i * 4) for i in range(shelves)]


def blade_plan():
    return [('n93180', 'core', 42), ('n93180', 'core', 41), ('pp24', 'patch', 40),
            ('synergy', 'blade', 1), ('synergy', 'blade', 11), ('r650', 'server', 21)]


# ------------------------------------------------------------------ builders

def make_rack(site, location, name, role, plan, tenant=None, status='active', width=600, site_code='X', panel=None):
    rack = Rack.objects.create(
        site=site, location=location, name=name, status=status, role=RACK_ROLES[role],
        tenant=TENANTS.get(tenant), u_height=42, width=19, form_factor='4-post-cabinet',
        outer_width=width, outer_depth=1200, outer_unit='mm',
        facility_id=name.split('-')[-1],
    )
    if not plan:
        return rack

    # Server racks get a 16 A three-phase feed (about 8.9 kW usable), network racks 16 A single phase (about 2.9 kW)
    three_phase = role in ('compute', 'storage')
    feed = PowerFeed.objects.create(
        power_panel=panel, rack=rack, name=f'{name}-A', status='active', max_utilization=80, amperage=16,
        voltage=400 if three_phase else 230, phase='three-phase' if three_phase else 'single-phase',
    )
    pdu = Device.objects.create(
        site=site, location=location, rack=rack, name=f'{name}-PDU-A', device_type=pdu_type,
        role=ROLES['pdu'], status='active',
    )
    Cable(a_terminations=[feed], b_terminations=[pdu.powerports.get()]).save()
    outlets = sorted(pdu.poweroutlets.all(), key=lambda o: o.name)

    for entry in plan:
        key, role, position = entry[:3]
        face = entry[3] if len(entry) > 3 else 'front'
        dt = TYPES[key]
        device = Device.objects.create(
            site=site, location=location, rack=rack, position=position, face=face,
            device_type=dt, role=ROLES[role], tenant=TENANTS.get(tenant),
            name=device_name(site_code, role) or f'{name}-{dt.model.split()[0]}-U{position}',
            status=rng.choice(['active'] * 9 + ['planned']),
            serial=f'{dt.manufacturer.name[:3].upper()}{rng.randint(10**7, 10**8 - 1)}',
            asset_tag=f'AT-{rng.randint(100000, 999999)}' if role in ('server', 'storage', 'blade') else None,
        )
        port = device.powerports.first()
        if port and outlets:
            Cable(a_terminations=[outlets.pop(0)], b_terminations=[port]).save()
    return rack


def place(layout, rack, x, y, rotation):
    RackPlacement.objects.create(layout=layout, rack=rack, x=x, y=y, rotation=rotation)


def floor_object(layout, kind, x, y, w, h, label=''):
    RoomObject.objects.create(layout=layout, kind=kind, x=x, y=y, width=w, height=h, label=label)


def spare(site, location, key, role, site_code, count=1):
    for _ in range(count):
        Device.objects.create(
            site=site, location=location, device_type=TYPES[key], role=ROLES[role], status='inventory',
            name=device_name(site_code, role), serial=f'SPR{rng.randint(10**6, 10**7 - 1)}',
        )


def room(site, name, parent=None):
    return Location.objects.create(site=site, parent=parent, name=name, slug=slug(name), status='active')


# ------------------------------------------------------------------ Melbourne data hall

region = Region.objects.get_or_create(name='Australia', slug='australia')[0]

mel = Site.objects.create(name='Melbourne DC', slug='mel-dc', region=region, status='active')
hall = room(mel, 'Data Hall 1')
panel = PowerPanel.objects.create(site=mel, location=hall, name='DH1 PP-1')
layout = RoomLayout.objects.create(location=hall, columns=30, rows=16, tile_size=600)

row_a = [('network', network_plan(), 'Infrastructure'), ('network', network_plan(), 'Infrastructure')] + \
    [('compute', compute_plan(f), 'Engineering') for f in (0.35, 0.55, 0.8, 0.95, 0.65, 0.2)] + \
    [('storage', storage_plan(4), 'Shared Services'), ('storage', storage_plan(7), 'Shared Services'),
     ('compute', blade_plan(), 'Engineering'), ('compute', compute_plan(0.45), 'Finance')]
row_b = [('compute', compute_plan(f), t) for f, t in
         ((0.9, 'Finance'), (0.7, 'Finance'), (0.5, 'Finance'), (0.3, 'Engineering'), (0.85, 'Engineering'),
          (0.6, 'Engineering'), (0.15, 'Engineering'), (0.75, 'Shared Services'))] + \
    [('storage', storage_plan(5), 'Shared Services'), ('compute', compute_plan(0.4), 'Shared Services'),
     ('comms', access_plan(4), 'Infrastructure'), ('network', network_plan(), 'Infrastructure')]

# Row A fronts face south into the cold aisle, row B fronts face north into it
for i, (role, plan, tenant) in enumerate(row_a):
    rack = make_rack(mel, hall, f'MEL-DH1-A{i + 1:02d}', role, plan, tenant, site_code='MEL', panel=panel)
    place(layout, rack, 8 + i, 4, 0)
for i, (role, plan, tenant) in enumerate(row_b):
    rack = make_rack(mel, hall, f'MEL-DH1-B{i + 1:02d}', role, plan, tenant, site_code='MEL', panel=panel)
    place(layout, rack, 8 + i, 8, 180)
# Planned racks waiting to be placed
for n in (1, 2):
    make_rack(mel, hall, f'MEL-DH1-C{n:02d}', 'compute', [], 'Engineering', status='planned', site_code='MEL')

floor_object(layout, 'hot_aisle', 8, 2, 12, 2, 'Hot aisle')
floor_object(layout, 'cold_aisle', 8, 6, 12, 2, 'Cold aisle A/B')
floor_object(layout, 'hot_aisle', 8, 10, 12, 2, 'Hot aisle')
for y in (2, 6, 10):
    floor_object(layout, 'crac', 0, y, 1, 3, f'CRAC-{y // 4 + 1}')
floor_object(layout, 'crac', 29, 6, 1, 3, 'CRAC-4')
floor_object(layout, 'ups', 23, 13, 4, 2, 'UPS room feed')
floor_object(layout, 'pdu', 22, 4, 1, 2, 'PDU-A')
floor_object(layout, 'pdu', 22, 8, 1, 2, 'PDU-B')
floor_object(layout, 'column', 5, 7, 1, 1)
floor_object(layout, 'column', 24, 7, 1, 1)
floor_object(layout, 'door', 13, 15, 3, 1, 'Main door')
floor_object(layout, 'area', 2, 13, 6, 3, 'Staging')
spare(mel, hall, 'r650', 'server', 'MEL', 3)
spare(mel, hall, 'c9300', 'access', 'MEL')

# Reserve some space for an upcoming project
reserved_rack = Rack.objects.get(name='MEL-DH1-A08')
RackReservation.objects.create(
    rack=reserved_rack, units=[20, 21, 22, 23], user=admin, description='Project Falcon compute nodes',
    tenant=TENANTS['Engineering'],
)

# ------------------------------------------------------------------ Sydney HQ comms rooms

syd = Site.objects.create(name='Sydney HQ', slug='syd-hq', region=region, status='active')
tower_a = room(syd, 'Tower A')
tower_b = room(syd, 'Tower B')

l2 = room(syd, 'Level 2 Comms Room', tower_a)
panel = PowerPanel.objects.create(site=syd, location=l2, name='L2 DB-1')
layout = RoomLayout.objects.create(location=l2, columns=12, rows=8, tile_size=600)
l2_plans = [('network', network_plan(), 'Infrastructure'), ('comms', access_plan(4), 'Infrastructure'),
            ('comms', access_plan(3), 'Infrastructure'), ('comms', access_plan(2), 'Infrastructure'),
            ('compute', compute_plan(0.3), 'Finance'), ('compute', compute_plan(0.6), 'Finance')]
for i, (role, plan, tenant) in enumerate(l2_plans):
    rack = make_rack(syd, l2, f'SYD-L2-R{i + 1:02d}', role, plan, tenant, site_code='SYD', panel=panel)
    place(layout, rack, 3 + i, 1, 0)
floor_object(layout, 'cold_aisle', 3, 3, 6, 2, 'Cold aisle')
floor_object(layout, 'crac', 0, 1, 1, 2, 'Split AC')
floor_object(layout, 'door', 10, 7, 2, 1, 'Door')
spare(syd, l2, 'c9300', 'access', 'SYD')

l14 = room(syd, 'Level 14 Comms Room', tower_a)
panel = PowerPanel.objects.create(site=syd, location=l14, name='L14 DB-1')
for i, (role, plan) in enumerate([('network', network_plan()), ('comms', access_plan(3)),
                                  ('comms', access_plan(2)), ('comms', access_plan(1))]):
    make_rack(syd, l14, f'SYD-L14-R{i + 1:02d}', role, plan, 'Infrastructure', site_code='SYD', panel=panel)
# No layout yet: try placing these racks yourself

mdf = room(syd, 'Ground Floor MDF', tower_b)
panel = PowerPanel.objects.create(site=syd, location=mdf, name='MDF DB-1')
layout = RoomLayout.objects.create(location=mdf, columns=14, rows=10, tile_size=600)
mdf_plans = [('network', network_plan()), ('network', network_plan()), ('comms', access_plan(4)),
             ('compute', compute_plan(0.5)), ('compute', compute_plan(0.7)), ('storage', storage_plan(3)),
             ('comms', access_plan(3)), ('compute', compute_plan(0.25))]
for i, (role, plan) in enumerate(mdf_plans):
    rack = make_rack(syd, mdf, f'SYD-MDF-R{i + 1:02d}', role, plan, 'Infrastructure', site_code='SYD', panel=panel,
                     width=800 if role == 'network' else 600)
    col = [2, 4, 6, 7][i % 4]
    if i < 4:
        place(layout, rack, col, 1, 0)
    else:
        place(layout, rack, col, 5, 180)
floor_object(layout, 'cold_aisle', 2, 3, 7, 2, 'Cold aisle')
floor_object(layout, 'crac', 12, 2, 1, 3, 'CRAC-1')
floor_object(layout, 'ups', 10, 7, 3, 2, 'UPS')
floor_object(layout, 'door', 0, 8, 1, 2, 'Door')

# ------------------------------------------------------------------ Brisbane office

bne = Site.objects.create(name='Brisbane Office', slug='bne-office', region=region, status='active')
comms = room(bne, 'Comms Room')
panel = PowerPanel.objects.create(site=bne, location=comms, name='BNE DB-1')
layout = RoomLayout.objects.create(location=comms, columns=8, rows=6, tile_size=600)
for i, (role, plan) in enumerate([('network', network_plan()), ('comms', access_plan(3)), ('compute', compute_plan(0.4))]):
    rack = make_rack(bne, comms, f'BNE-CR-R{i + 1:02d}', role, plan, 'Infrastructure', site_code='BNE', panel=panel)
    place(layout, rack, 2 + i, 1, 0)
floor_object(layout, 'crac', 7, 1, 1, 2, 'Split AC')
floor_object(layout, 'door', 0, 4, 1, 2, 'Door')

print(f'Created {Rack.objects.filter(site__region=region).count()} racks and '
      f'{Device.objects.filter(site__region=region).count()} devices in '
      f'{Location.objects.filter(site__region=region, racks__isnull=False).distinct().count()} comms rooms.')

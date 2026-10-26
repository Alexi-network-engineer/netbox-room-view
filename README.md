# NetBox Room View

A NetBox 4.6 plugin that gives every comms room a floor plan and rack elevation view inspired by dcTrack, with drag and drop.

## What it does

Each location that contains racks gets a **Room View** tab. **Plugins → Comms Rooms** lists every room.

**Floor plan**
- Shows a top-down tile grid of the room, with column letters and row numbers (for example, rack at N5).
- Draws racks at their real footprint from the rack's outer width and depth, with a dark bar on the front door edge.
- Colours racks by **space used**, **power used**, **rack role**, **status** or **tenant**, with a legend.
- Shows a hover tooltip with status, location, space, power, device count, role and tenant.
- Floor objects mark out the room: cold and hot aisles, cooling units, UPS, power distribution, columns, doors and labelled areas.
- **Search** for a rack, device name, serial, asset tag or model. Matching racks stay lit and the rest dim. Press Enter to open the first match; matching devices are highlighted in its elevation.

**3D view.** Switch the floor plan between **2D** and **3D**. The 3D view shows:
- racks at their real height, coloured by the same metric, with each device drawn as a coloured slab on the rack's front and rear faces
- aisles, cooling units, UPS, columns, doors, the far walls and a north marker

Drag to orbit, Shift-drag or right-drag to pan, and scroll to zoom. Buttons rotate 45°, jump to a top-down view, reset the camera and auto-rotate. Clicking a rack opens its elevation, just as in 2D. The renderer is built in, so nothing loads from the internet. Rearranging racks and floor objects is done in 2D.

**Rack panel.** Click a rack to see:
- space and power bars
- front and rear elevations, with devices coloured by role
- full-depth devices shown hatched on their far side
- reserved units

Double-click a device to open it in NetBox.

**Edit mode (drag and drop)**
- Drag racks to move them. Press **R** or click **Rotate** to turn the selected rack. Click **Remove from floor** to take a rack off the plan.
- Drag racks that aren't on the plan yet from the list below the floor plan onto the floor.
- Drag floor objects from the palette, move them, and resize them with the corner handle. Select one to change its label or type, or press Delete.
- Drag a device:
  - to another U position, or to the other side of the rack
  - onto a different rack on the floor plan, where it goes into the same U if free, otherwise the highest free slot
  - into the **unracked devices** tray to take it out of the rack
- Drag unracked devices into a rack the same way.
- Resize the room in tiles.

Device moves are ordinary NetBox edits. NetBox validates them (no overlaps, the device must fit), records them in the change log and checks your permissions. Racks can't overlap or extend past the room edge.

## Permissions

No new permissions to set up; Room View uses NetBox's existing ones:

| To... | You need |
|---|---|
| See a room | `dcim.view_location` and `dcim.view_rack` |
| Edit the floor plan (place racks, aisles, room size) | `dcim.change_rack` and `dcim.change_location` |
| Move devices | `dcim.change_device` |

Object-level permission constraints are enforced. The **Edit mode** switch only appears for users who can edit something.

## Requirements

- NetBox 4.6.x
- Python 3.12+

## Installation (no internet on the NetBox server)

The plugin ships as a single file, a Python wheel, attached to each [GitHub release](../../releases). It has no dependencies beyond NetBox itself, so the server never needs to reach GitHub or PyPI.

**Before you start:** check your NetBox version in the footer of any NetBox page. This release needs **4.6.x**, and NetBox won't load it on other versions. The plugin adds its own database tables, so take a database backup as you would before any upgrade.

1. **On your Windows PC**, open the [latest release](../../releases/latest) and download `netbox_room_view-<version>-py3-none-any.whl`.

2. **Copy it to the NetBox server.** Either drag and drop it into `/tmp` with WinSCP, or use the `scp` built into PowerShell:

   ```powershell
   scp $HOME\Downloads\netbox_room_view-0.1.1-py3-none-any.whl you@netbox-server:/tmp/
   ```

3. **On the server**, keep the wheel somewhere permanent and install it into NetBox's virtual environment. `--no-index` stops pip from trying to reach the internet:

   ```bash
   sudo mkdir -p /opt/netbox/plugins
   sudo mv /tmp/netbox_room_view-0.1.1-py3-none-any.whl /opt/netbox/plugins/
   sudo /opt/netbox/venv/bin/pip install --no-index /opt/netbox/plugins/netbox_room_view-0.1.1-py3-none-any.whl
   echo /opt/netbox/plugins/netbox_room_view-0.1.1-py3-none-any.whl | sudo tee -a /opt/netbox/local_requirements.txt
   ```

   The last line makes NetBox's `upgrade.sh` reinstall the plugin after a NetBox upgrade.

4. **Enable the plugin** in `/opt/netbox/netbox/netbox/configuration.py`. If `PLUGINS` already lists other plugins, add `'netbox_room_view'` to that list:

   ```python
   PLUGINS = ['netbox_room_view']

   PLUGINS_CONFIG = {
       'netbox_room_view': {
           'tile_size': 600,            # floor tile size in mm
           'default_columns': 20,       # floor size for rooms without a saved layout
           'default_rows': 12,
           'default_rack_depth': 1200,  # mm, for racks with no outer depth set
       },
   }
   ```

5. **Create the plugin's tables and restart NetBox.** This plugin stores floor layouts, so unlike a view-only plugin it has migrations:

   ```bash
   sudo /opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py migrate
   sudo systemctl restart netbox netbox-rq
   ```

6. **Check it loaded:** **Admin → System → Plugins** should list *Room View*, and locations with racks get a **Room View** tab.

### Getting good results

- Set **outer width** and **outer depth** on your racks or rack types so they are drawn to size. Without them, racks default to 600 mm wide (800 mm for 23" racks) and 1200 mm deep.
- **Power used** comes from NetBox's rack power utilisation. It needs power feeds assigned to the rack, cabled through to device power ports that have an allocated draw. Racks without feeds show as grey in power mode.
- Room View treats any location that directly contains racks as a room.

### Upgrading

Copy the new wheel to `/opt/netbox/plugins/` as in step 3, then install it and apply any new migrations:

```bash
sudo /opt/netbox/venv/bin/pip install --no-index /opt/netbox/plugins/netbox_room_view-<version>-py3-none-any.whl
sudo /opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py migrate
sudo systemctl restart netbox netbox-rq
```

Also update the wheel path in `/opt/netbox/local_requirements.txt` to the new file, so `upgrade.sh` doesn't reinstall the old version.

### Uninstalling

Remove `'netbox_room_view'` from `PLUGINS`, then run `sudo /opt/netbox/venv/bin/pip uninstall netbox-room-view` and restart NetBox. Floor layouts stay in the database tables `netbox_room_view_*` until you drop them.

## Trying it locally

`demo/` has a throwaway NetBox in Docker with sample sites, rooms, racks, devices and power. See [demo/README.md](demo/README.md).

## Structure

```
demo/                     # Docker NetBox and sample data
netbox_room_view/
├── __init__.py           # PluginConfig and default settings
├── models.py             # RoomLayout, RackPlacement, RoomObject
├── migrations/
├── navigation.py         # Plugins → Comms Rooms
├── urls.py
├── utils.py              # Rack footprints, collision checks, page data
├── views.py              # Room View tab, room list and JSON endpoints
└── templates/netbox_room_view/
    ├── room.html         # Room View tab
    ├── room_list.html
    └── inc/              # roomview.css, roomview.js and roomview3d.js (inlined, no collectstatic needed)
```

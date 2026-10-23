from netbox.plugins import PluginConfig


class RoomViewConfig(PluginConfig):
    name = 'netbox_room_view'
    verbose_name = 'Room View'
    description = 'Floor plan and rack elevation view for comms rooms, with drag and drop'
    version = '0.1.0'
    author = 'Networks Team'
    base_url = 'room-view'
    min_version = '4.6.0'
    max_version = '4.6.99'
    default_settings = {
        # Size of one floor tile in millimetres
        'tile_size': 600,
        # Floor size used for rooms that have no saved layout yet
        'default_columns': 20,
        'default_rows': 12,
        # Footprint used for racks with no outer width/depth set
        'default_rack_depth': 1200,
    }

    def ready(self):
        super().ready()
        # Registers the Room View tab on Location
        from . import views  # noqa: F401


config = RoomViewConfig

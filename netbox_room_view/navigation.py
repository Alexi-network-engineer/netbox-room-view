from netbox.plugins import PluginMenuItem

menu_items = (
    PluginMenuItem(
        link='plugins:netbox_room_view:room_list',
        link_text='Comms Rooms',
        permissions=['dcim.view_location'],
    ),
)

from django.urls import path

from . import views

app_name = 'netbox_room_view'

urlpatterns = [
    path('', views.RoomListView.as_view(), name='room_list'),
    path('api/rooms/<int:pk>/', views.RoomApiView.as_view(), name='api_room'),
    path('api/rooms/<int:pk>/layout/', views.LayoutApiView.as_view(), name='api_layout'),
    path('api/rooms/<int:pk>/placements/', views.PlacementApiView.as_view(), name='api_placements'),
    path('api/rooms/<int:pk>/objects/', views.ObjectApiView.as_view(), name='api_objects'),
    path('api/racks/<int:pk>/', views.RackApiView.as_view(), name='api_rack'),
    path('api/devices/<int:pk>/move/', views.DeviceMoveApiView.as_view(), name='api_device_move'),
]

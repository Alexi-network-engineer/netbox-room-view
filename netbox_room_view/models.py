from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models


class RoomLayout(models.Model):
    """Floor dimensions for a comms room (a dcim.Location), measured in tiles."""
    location = models.OneToOneField(
        to='dcim.Location',
        on_delete=models.CASCADE,
        related_name='room_layout',
    )
    columns = models.PositiveSmallIntegerField(validators=[MinValueValidator(1), MaxValueValidator(200)])
    rows = models.PositiveSmallIntegerField(validators=[MinValueValidator(1), MaxValueValidator(200)])
    tile_size = models.PositiveSmallIntegerField(help_text='Tile size in millimetres')

    def __str__(self):
        return f'Layout for {self.location}'


class RackPlacement(models.Model):
    """Where a rack stands on the floor. `rotation` is the direction its front faces."""
    ROTATIONS = ((0, 'South'), (90, 'West'), (180, 'North'), (270, 'East'))

    rack = models.OneToOneField(
        to='dcim.Rack',
        on_delete=models.CASCADE,
        related_name='room_placement',
    )
    layout = models.ForeignKey(
        to=RoomLayout,
        on_delete=models.CASCADE,
        related_name='placements',
    )
    x = models.PositiveSmallIntegerField()
    y = models.PositiveSmallIntegerField()
    rotation = models.PositiveSmallIntegerField(choices=ROTATIONS, default=0)

    def __str__(self):
        return f'{self.rack} at {self.x},{self.y}'


class RoomObject(models.Model):
    """Non-rack floor items: aisles, cooling units, columns and so on."""
    KINDS = (
        ('cold_aisle', 'Cold aisle'),
        ('hot_aisle', 'Hot aisle'),
        ('crac', 'Cooling unit'),
        ('ups', 'UPS'),
        ('pdu', 'Power distribution'),
        ('column', 'Column'),
        ('door', 'Door'),
        ('area', 'Area'),
    )

    layout = models.ForeignKey(
        to=RoomLayout,
        on_delete=models.CASCADE,
        related_name='floor_objects',
    )
    kind = models.CharField(max_length=20, choices=KINDS)
    label = models.CharField(max_length=50, blank=True)
    x = models.PositiveSmallIntegerField()
    y = models.PositiveSmallIntegerField()
    width = models.PositiveSmallIntegerField(validators=[MinValueValidator(1)])
    height = models.PositiveSmallIntegerField(validators=[MinValueValidator(1)])

    class Meta:
        ordering = ('pk',)

    def __str__(self):
        return self.label or self.get_kind_display()

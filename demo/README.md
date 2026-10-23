# Demo NetBox for trying Room View

A throwaway NetBox 4.6 (Postgres + Valkey) with the plugin installed, on http://localhost:8001. Run all commands from this `demo` folder.

```powershell
docker compose up -d --build          # first start takes a few minutes (migrations)
docker compose ps                     # wait until netbox shows "healthy"
docker compose cp seed_rooms.py netbox:/tmp/seed_rooms.py
docker compose exec -T netbox /opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py nbshell --command "exec(open('/tmp/seed_rooms.py', encoding='utf-8-sig').read())"
```

Log in as `admin` / `admin`, then open **Plugins → Comms Rooms**.

The seed script creates four sites and five comms rooms with about 50 racks and 600 devices. Each rack has a power feed, a PDU and cabled device power supplies, so power utilisation is real NetBox data. It also adds aisles, cooling units, a rack reservation and some unracked spares.

- **Data Hall 1** (Melbourne DC) has two rows of racks around a cold aisle, plus two planned racks waiting to be placed.
- **Level 14 Comms Room** (Sydney HQ) has racks but no floor plan yet, so you can try laying one out from scratch.

The plugin source is bind-mounted, so after editing code run `docker compose restart netbox`. Templates are cached, so the restart is needed for template, CSS and JavaScript changes too.

## Delete everything

```powershell
docker compose down -v --rmi local
```

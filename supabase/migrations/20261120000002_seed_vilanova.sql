-- First spot: Vilanova i la Geltrú (Platja de Vilanova).
-- beach_orientation 165 = faces SSE (to be checked on a map).
-- Buoys: 1731 Barcelona II (coastal, waves only), 2720 Tarragona (offshore, waves + wind).
-- windy_cam_id and water_polygon are filled in when the cam step is built.
insert into public.spots (id, name, lat, lon, beach_orientation, windy_cam_id, buoy_ids, water_polygon)
values (
    'vilanova',
    'Vilanova i la Geltrú (Platja de Vilanova)',
    41.2097,
    1.7128,
    165,
    null,
    array['1731', '2720'],
    null
)
on conflict (id) do nothing;

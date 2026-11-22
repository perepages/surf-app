-- Webcam for Vilanova, chosen 2026-11-22 from the Windy Webcams API v3 cams within 5 km:
-- 1793884698 "Vilanova i la Geltru - North-west" (3Cat), 1.3 km from the spot, looks along the
-- beach at the breaking waves. (The other one, 1715343359 Avinguda de Rocacrespa, shows no sea.)
-- Already applied on the live database via the REST API on 2026-11-22; safe to run again.
update public.spots set windy_cam_id = '1793884698' where id = 'vilanova';

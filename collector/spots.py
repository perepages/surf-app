"""Surf spots the app knows about."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Spot:
    slug: str
    name: str
    lat: float
    lon: float
    collect: bool = True  # False = kept for past data only, not fetched hourly


SPOTS: list[Spot] = [
    Spot(slug="vilanova", name="Vilanova i la Geltrú", lat=41.21061, lon=1.71594),
    # Barcelona. Only used for one reported "really good" day (2026-11-05) as an
    # example of a forecast that verified; not collected live.
    Spot(slug="bogatell", name="Bogatell (Barcelona)", lat=41.3946, lon=2.2077, collect=False),
]


def get_spot(slug: str) -> Spot:
    """Look up a spot by slug (raises KeyError if unknown)."""
    for spot in SPOTS:
        if spot.slug == slug:
            return spot
    raise KeyError(slug)

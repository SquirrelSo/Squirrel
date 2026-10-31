"""Pure proximity scoring — RSSI bands and repeated-sighting confirmation."""

from __future__ import annotations

from backend.nearby import proximity as X
from backend.nearby.proximity import Sample, assess, classify_rssi


def test_rssi_bands():
    assert classify_rssi(-45) == "very_close"
    assert classify_rssi(-60) == "very_close"
    assert classify_rssi(-61) == "nearby"
    assert classify_rssi(-75) == "nearby"
    assert classify_rssi(-76) == "far"


def test_single_packet_never_confirms():
    a = assess([Sample(at=0, rssi=-50, observer="a")])
    assert a is not None and not a.confirmed


def test_walk_past_does_not_confirm():
    """Strong but brief: three sightings in 15 s is someone walking past."""
    a = assess([Sample(at=t, rssi=-55, observer="a") for t in (0, 5, 15)])
    assert not a.confirmed


def test_sitting_nearby_confirms():
    a = assess([Sample(at=t, rssi=-58, observer="a") for t in (0, 30, 60)])
    assert a.confirmed and a.proximity == "very_close" and not a.mutual
    assert 0 < a.confidence < 1


def test_far_median_does_not_confirm_even_with_dwell():
    a = assess([Sample(at=t, rssi=r, observer="a") for t, r in ((0, -80), (30, -58), (60, -85), (90, -82))])
    assert not a.confirmed and a.proximity == "far"


def test_median_resists_single_outlier():
    a = assess([Sample(at=t, rssi=r, observer="a") for t, r in ((0, -65), (30, -95), (60, -66), (90, -64))])
    assert a.confirmed and a.proximity == "nearby"


def test_mutual_sightings_raise_confidence():
    one_sided = assess([Sample(at=t, rssi=-65, observer="a") for t in (0, 30, 60, 90)])
    mutual = assess([Sample(at=t, rssi=-65, observer="a" if t % 60 else "b") for t in (0, 30, 60, 90)])
    assert mutual.mutual and mutual.confidence > one_sided.confidence


def test_old_samples_fall_out_of_the_window():
    old = [Sample(at=t, rssi=-55, observer="a") for t in (0, 30, 60)]
    new = [Sample(at=X.EVIDENCE_WINDOW_SECONDS + 1000, rssi=-55, observer="a")]
    a = assess(old + new)
    assert a.count == 1 and not a.confirmed

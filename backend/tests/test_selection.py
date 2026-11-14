from collections import Counter

from app import irsa


def obs(mjd, det, contains=True, i=0):
    return {"url": f"https://x/level2/f_{mjd}_{det}_{i}.fits", "mjd": mjd, "detector": det,
            "obs_id": f"o{mjd}_{i}", "contains_target": contains}


def make(passes=(60800, 60990, 61170), per_cell=5):
    out = []
    for p in passes:
        for d in range(1, 7):
            for k in range(per_cell):
                out.append(obs(p + k * 2.0 + d * 0.01, d, i=k))
    return out


def test_every_epoch_gets_all_detectors_and_budget_respected():
    sel = irsa.select_frames(make(), max_frames=40)
    frames = sel["frames"]
    assert len(frames) == 40
    assert len(sel["epochs"]) == 3
    per_epoch = Counter((f["epoch"], f["detector"]) for f in frames)
    for e in range(3):
        assert all(per_epoch[(e, d)] >= 2 for d in range(1, 7))
    assert [f["mjd"] for f in frames] == sorted(f["mjd"] for f in frames)


def test_frames_spread_in_time_within_a_cell():
    sel = irsa.select_frames(make(passes=(60800,), per_cell=9), max_frames=18)
    d1 = sorted(f["mjd"] for f in sel["frames"] if f["detector"] == 1)
    assert len(d1) == 3
    assert d1[0] < 60801 and d1[-1] > 60816   # first and last of the pass, not 3 adjacent


def test_footprint_filter_and_unknown_kept():
    data = make(passes=(60800,), per_cell=1)
    data.append(obs(60801, 1, contains=False, i=9))
    data.append(obs(60802, 2, contains=None, i=9))
    sel = irsa.select_frames(data, max_frames=40)
    urls = {f["url"] for f in sel["frames"]}
    assert not any("_9.fits" in u and "60801" in u for u in urls)
    assert any("60802" in u for u in urls)
    assert sel["n_candidates"] == 7


def test_too_many_passes_keeps_spread_passes():
    passes = tuple(60000 + 180 * k for k in range(10))
    sel = irsa.select_frames(make(passes=passes, per_cell=1), max_frames=24)
    assert len(sel["epochs"]) == 4
    assert sel["n_passes_total"] == 10
    starts = [e["mjd_start"] for e in sel["epochs"]]
    assert starts[0] < 60001 and starts[-1] > 61600


def test_missing_detector_reported():
    data = [o for o in make(passes=(60800,), per_cell=2) if o["detector"] != 4]
    sel = irsa.select_frames(data, max_frames=40)
    assert sel["epochs"][0]["missing_detectors"] == [4]
    assert len(sel["frames"]) == 10


def test_empty():
    assert irsa.select_frames([], 40)["frames"] == []

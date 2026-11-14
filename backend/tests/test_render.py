import io

import numpy as np
import pytest
from PIL import Image

from app import render
from app.errors import BadRequest


def decode(png: bytes) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(png)).convert("RGBA"))


@pytest.mark.parametrize("stretch", render.STRETCHES)
def test_stretches_monotonic_and_bounded(stretch):
    x = np.linspace(-0.5, 1.5, 101)
    y = render.apply_stretch(x, stretch)
    assert y.min() == 0 and y.max() == pytest.approx(1)
    assert np.all(np.diff(y) >= 0)


def test_robust_stats():
    rng = np.random.default_rng(1)
    a = rng.normal(10, 2, 100_000)
    a[:500] = 1e6                       # outliers barely move a MAD estimate
    a[600] = np.nan
    med, sig = render.robust_stats(a)
    assert med == pytest.approx(10, abs=0.05) and sig == pytest.approx(2, rel=0.03)


def test_png_north_up_upscale_and_nan_transparent():
    img = np.zeros((5, 7), np.float32)
    img[4, 0] = 10.0                    # top row in sky (north), east edge (left)
    img[0, 6] = np.nan
    png, info = render.render_image(img, vmin=0, vmax=10, stretch="linear", cmap="gray", upscale=3)
    px = decode(png)
    assert px.shape == (15, 21, 4)
    assert tuple(px[0, 0, :3]) == (255, 255, 255)        # north row appears at the top
    assert px[14, 20, 3] == 0                            # NaN is transparent
    assert px[7, 10, 3] == 255
    assert info["vmin"] == 0


def test_bad_params():
    with pytest.raises(BadRequest):
        render.render_image(np.zeros((3, 3)), stretch="cubic")
    with pytest.raises(BadRequest):
        render.render_image(np.zeros((3, 3)), cmap="RdBu_r")      # diff colour map on an image
    with pytest.raises(BadRequest):
        render.render_difference(np.zeros((3, 3)), cmap="inferno")
    with pytest.raises(BadRequest):
        render.render_image(np.zeros((3, 3)), upscale=9)


def test_tail_levels_flatten_noise_keep_extremes():
    rng = np.random.default_rng(0)
    diff = rng.normal(0.0, 1.0, (200, 200))
    diff[50, 50] = 40.0                 # strong brightening
    diff[150, 150] = -40.0              # strong fading
    diff[100, 100] = 3.5                # just above k=3
    diff[10, 10] = np.nan
    levels, stats = render.tail_levels(diff, 3.0)
    assert stats["sigma"] == pytest.approx(1.0, rel=0.03)
    finite = levels[np.isfinite(levels)]
    neutral = np.mean(finite == 0.5)
    assert neutral > 0.99                                    # noise -> ONE constant level
    assert len(np.unique(finite[np.abs(diff[np.isfinite(levels)]) < 2.5])) == 1
    assert levels[50, 50] == pytest.approx(1.0)              # full red at/after the limit
    assert levels[150, 150] == pytest.approx(0.0)            # full blue
    s = 2 * (levels[100, 100] - 0.5)                         # just past k: strength ~0.35
    assert 0.35 <= s < 0.6
    assert np.isnan(levels[10, 10])
    assert stats["n_positive"] >= 2 and stats["n_negative"] >= 1


def test_tail_zero_is_raw_and_symmetric():
    diff = np.array([[-10.0, -1.0, 0.0, 1.0, 10.0]] * 5)
    levels, stats = render.tail_levels(diff, 0.0, median=0.0, sigma=1.0)
    assert levels[0, 2] == 0.5
    assert levels[0, 1] == pytest.approx(0.5 - 0.1) and levels[0, 3] == pytest.approx(0.6)
    assert levels[0, 0] == 0.0 and levels[0, 4] == 1.0
    assert stats["vmin"] == -5 and stats["vmax"] == 5


def test_render_difference_colours():
    rng = np.random.default_rng(2)
    diff = rng.normal(0, 1, (40, 40))
    diff[20, 20] = 50
    png, stats = render.render_difference(diff, tail=3, cmap="RdBu_r")
    px = decode(png)
    red = px[40 - 1 - 20, 20, :3].astype(int)       # flipped rows
    assert red[0] > red[2] + 50                       # positive change is red
    corner = px[0, 0, :3]
    assert tuple(px[1, 1, :3]) == tuple(corner) or abs(diff[38, 1]) > 3

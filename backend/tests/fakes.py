"""Synthetic SPHEREx-like cutouts and HTTP responses (no network)."""
from __future__ import annotations

import io
import math
from urllib.parse import parse_qs, urlparse

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

PIX = 6.2 / 3600.0


def cutout_wcs(ra0, dec0, n, rot_deg=30.0) -> WCS:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra0, dec0]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    c, s = math.cos(math.radians(rot_deg)), math.sin(math.radians(rot_deg))
    w.wcs.cd = np.array([[-PIX * c, PIX * s], [PIX * s, PIX * c]])
    return w


def make_cutout_fits(ra0, dec0, n=47, *, star=None, detector=3, rot_deg=30.0,
                     bad_pixel=None, source_pixel=None, epsf_rows=200, wave=True,
                     seed=0) -> bytes:
    """star = (ra, dec, amplitude). bad_pixel/source_pixel = (x, y) to flag."""
    rng = np.random.default_rng(seed)
    w = cutout_wcs(ra0, dec0, n, rot_deg)
    hdr = w.to_header()
    hdr["DETECTOR"] = detector
    hdr["MJD-AVG"] = 60800.5
    hdr["DATE-AVG"] = "2025-05-05T12:00:00"
    hdr["PSF_FWHM"] = 7.4
    zodi = np.full((n, n), 0.13, np.float32)
    img = zodi + rng.normal(0, 0.01, (n, n)).astype(np.float32)
    if star is not None:
        sx, sy = w.world_to_pixel_values(star[0], star[1])
        yy, xx = np.mgrid[0:n, 0:n]
        img += (star[2] * np.exp(-((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * 0.6 ** 2))).astype(np.float32)
    var = np.full((n, n), 1e-4, np.float32)
    flags = np.zeros((n, n), np.int32)
    if bad_pixel is not None:
        flags[bad_pixel[1], bad_pixel[0]] |= 1 << 10          # HOT -> masked
    if source_pixel is not None:
        flags[source_pixel[1], source_pixel[0]] |= 1 << 21    # SOURCE -> not masked
    flags[0, 0] |= np.int32(-2**31)                            # bit 31 set (int32 sign bit)

    if wave:
        hdr["WCSAXESW"] = 2
        for i, (ctype, name) in enumerate((("WAVE-TAB", "X"), ("WAVE-TAB", "Y")), start=1):
            hdr[f"CTYPE{i}W"] = ctype
            hdr[f"CUNIT{i}W"] = "um"
            hdr[f"CRPIX{i}W"] = -100.0
            hdr[f"CDELT{i}W"] = 1.0
            hdr[f"CRVAL{i}W"] = 1.0
            hdr[f"PS{i}_0W"] = "WCS-WAVE"
            hdr[f"PS{i}_1W"] = "VALUES"
            hdr[f"PS{i}_2W"] = name
            hdr[f"PV{i}_3W"] = i
    image_hdu = fits.ImageHDU(img, header=hdr, name="IMAGE")
    hdus = [fits.PrimaryHDU(), image_hdu,
            fits.ImageHDU(flags, name="FLAGS"),
            fits.ImageHDU(var, name="VARIANCE"),
            fits.ImageHDU(zodi, name="ZODI")]
    if epsf_rows:
        hdus.append(fits.BinTableHDU.from_columns(
            [fits.Column(name="PSF", format="1089D", array=np.zeros((epsf_rows, 1089)))], name="EPSF"))
    if wave:
        xs = np.array([1, 1024, 2040], np.int32)
        ys = np.array([1, 1024, 2040], np.int32)
        vals = np.zeros((3, 3, 2), np.float32)                 # numpy (Y, X, 2) = FITS (2, X, Y)
        for j, yv in enumerate(ys):
            for i, xv in enumerate(xs):
                vals[j, i] = (2.0 + 0.0002 * xv, 0.05)
        cols = [fits.Column(name="X", format="3J", array=xs[None, :]),
                fits.Column(name="Y", format="3J", array=ys[None, :]),
                fits.Column(name="VALUES", format="18E", dim="(2,3,3)", array=vals[None, ...])]
        hdus.append(fits.BinTableHDU.from_columns(cols, name="WCS-WAVE"))
    buf = io.BytesIO()
    fits.HDUList(hdus).writeto(buf)
    return buf.getvalue()


class FakeStreamResponse:
    def __init__(self, content: bytes = b"", status: int = 200, headers: dict | None = None,
                 chunk: int = 8192):
        self.content = content
        self.status_code = status
        self.headers = headers or {}
        self._chunk = chunk
        self.bytes_sent = 0
        self.closed = False

    def iter_content(self, chunk_size=None):
        step = chunk_size or self._chunk
        for i in range(0, len(self.content), step):
            part = self.content[i:i + step]
            self.bytes_sent += len(part)
            yield part

    def close(self):
        self.closed = True


def parse_center(url: str) -> tuple[float, float, float]:
    q = parse_qs(urlparse(url).query)
    ra, dec = (float(v) for v in q["center"][0].split(","))
    return ra, dec, float(q["size"][0])

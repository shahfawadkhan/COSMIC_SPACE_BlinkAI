"""Read only the first HDUs of a FITS stream, then stop.

SPHEREx Level-2 cutouts are laid out as
    PRIMARY, IMAGE, FLAGS, VARIANCE, ZODI  (~110 kB for a 4' cutout)
    EPSF       (~3.9 MB PSF table, same for every cutout)
    WCS-WAVE   (~6 kB wavelength lookup table, fixed per detector)
Stopping after ZODI cuts each download by ~97 %.
"""
from __future__ import annotations

from typing import Iterable, Iterator

BLOCK = 2880
CARD = 80


class FitsStreamError(ValueError):
    pass


def _header_cards(block: bytes) -> tuple[dict[str, str], bool]:
    cards: dict[str, str] = {}
    for i in range(0, BLOCK, CARD):
        card = block[i:i + CARD].decode("ascii", "replace")
        key = card[:8].strip()
        if key == "END":
            return cards, True
        if card[8:10] == "= ":
            value = card[10:]
            if value.lstrip().startswith("'"):
                value = value.lstrip()[1:].split("'", 1)[0]
            else:
                value = value.split("/", 1)[0]
            cards[key] = value.strip()
    return cards, False


def _data_size(cards: dict[str, str]) -> int:
    try:
        bitpix = abs(int(cards.get("BITPIX", "8")))
        naxis = int(cards.get("NAXIS", "0"))
        if naxis == 0:
            return 0
        n = 1
        for i in range(1, naxis + 1):
            n *= int(cards[f"NAXIS{i}"])
        pcount = int(cards.get("PCOUNT", "0"))
        gcount = int(cards.get("GCOUNT", "1"))
    except (KeyError, ValueError) as exc:
        raise FitsStreamError(f"bad FITS header ({exc})") from exc
    size = bitpix // 8 * gcount * (pcount + n)
    return (size + BLOCK - 1) // BLOCK * BLOCK


def read_hdus_prefix(chunks: Iterable[bytes], want: set[str] | None) -> tuple[bytes, list[str]]:
    """Consume `chunks` until every EXTNAME in `want` has been read completely.

    Returns (bytes of the complete HDUs read, list of their names). With
    want=None the whole stream is read. Never returns a partial HDU.
    """
    it: Iterator[bytes] = iter(chunks)
    buf = bytearray()
    names: list[str] = []
    want_up = {w.upper() for w in want} if want is not None else None
    pos = 0

    def fill(n: int) -> bool:
        while len(buf) < n:
            try:
                chunk = next(it)
            except StopIteration:
                return False
            if chunk:
                buf.extend(chunk)
        return True

    while True:
        start = pos
        cards: dict[str, str] = {}
        while True:
            if not fill(pos + BLOCK):
                if pos == start and len(buf) <= start:
                    return bytes(buf[:start]), names  # clean end of file
                raise FitsStreamError("FITS stream ended inside a header")
            block_cards, ended = _header_cards(bytes(buf[pos:pos + BLOCK]))
            cards.update(block_cards)
            pos += BLOCK
            if ended:
                break
        size = _data_size(cards)
        if not fill(pos + size):
            raise FitsStreamError("FITS stream ended inside a data unit")
        pos += size
        names.append(cards.get("EXTNAME", "PRIMARY" if not names else "").upper())
        if want_up is not None and want_up <= set(names):
            return bytes(buf[:pos]), names

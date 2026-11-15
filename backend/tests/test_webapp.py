from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import webapp
from app.errors import install_handlers


def make(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>COSMIC</title>")
    (dist / "assets" / "app-1a2b.js").write_text("console.log(1)")
    (dist / "logo.svg").write_text("<svg/>")
    (tmp_path / "secret.txt").write_text("nope")
    app = FastAPI()
    install_handlers(app)

    @app.get("/api/ping")
    def ping():
        return {"ok": True}

    assert webapp.mount_frontend(app, dist.resolve()) == dist.resolve()
    return TestClient(app)


def test_serves_index_files_and_spa_routes(tmp_path):
    c = make(tmp_path)
    r = c.get("/")
    assert r.status_code == 200 and "COSMIC" in r.text and r.headers["cache-control"] == "no-cache"
    assert "COSMIC" in c.get("/explorer?ra=133.79&dec=-7.24").text      # client-side route -> index.html
    a = c.get("/assets/app-1a2b.js")
    assert a.text == "console.log(1)" and "immutable" in a.headers["cache-control"]
    assert c.get("/logo.svg").text == "<svg/>"


def test_api_routes_win_and_unknown_api_is_json_404(tmp_path):
    c = make(tmp_path)
    assert c.get("/api/ping").json() == {"ok": True}
    r = c.get("/api/does-not-exist")
    assert r.status_code == 404 and r.json()["code"] == "not_found"


def test_never_serves_files_outside_dist(tmp_path):
    c = make(tmp_path)
    r = c.get("/..%2Fsecret.txt")
    assert "nope" not in r.text


def test_static_dir_env(tmp_path, monkeypatch):
    monkeypatch.setenv("STATIC_DIR", "")
    assert webapp.static_dir() is None                                   # explicitly disabled
    monkeypatch.setenv("STATIC_DIR", str(tmp_path))
    assert webapp.static_dir() is None                                   # no index.html there
    (tmp_path / "index.html").write_text("x")
    assert webapp.static_dir() == tmp_path.resolve()

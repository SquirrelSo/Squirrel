from __future__ import annotations

from app.services.media import StoredObject
from tests.conftest import auth, new_sub


def _ticket(client, sub, **body):
    body = {"purpose": "post", "content_type": "image/jpeg", "byte_size": 204_800} | body
    return client.post("/v1/media/uploads", headers=auth(sub), json=body)


def test_upload_flow_and_post_with_photo(api, client, storage):
    sub = new_sub()
    api.me(sub)
    t = _ticket(client, sub)
    assert t.status_code == 201
    ticket = t.json()
    assert ticket["method"] == "PUT" and ticket["upload_url"].startswith("https://uploads.test/post/")
    # not uploaded yet
    assert client.post(f"/v1/media/{ticket['media_id']}/complete", headers=auth(sub)).status_code == 409
    r = client.post("/v1/posts", headers=auth(sub), json={"caption": "pic", "media_id": ticket["media_id"]})
    assert r.status_code == 422 and r.json()["code"] == "invalid_media"
    storage.objects[storage.presigned[0]] = StoredObject(byte_size=204_800, content_type="image/jpeg")
    done = client.post(f"/v1/media/{ticket['media_id']}/complete", headers=auth(sub)).json()
    assert done["status"] == "ready" and done["url"].startswith("https://cdn.test/")
    post = api.post(sub, caption="pic", media_id=ticket["media_id"])
    assert post["media_url"] == done["url"]


def test_upload_validation(api, client):
    sub = new_sub()
    api.me(sub)
    assert _ticket(client, sub, content_type="image/gif").json()["code"] == "unsupported_media_type"
    assert _ticket(client, sub, byte_size=50 * 1024 * 1024).json()["code"] == "media_too_large"


def test_upload_size_mismatch_rejected(api, client, storage):
    sub = new_sub()
    api.me(sub)
    ticket = _ticket(client, sub).json()
    storage.objects[storage.presigned[0]] = StoredObject(byte_size=999_999, content_type="image/jpeg")
    assert client.post(f"/v1/media/{ticket['media_id']}/complete", headers=auth(sub)).json()["code"] == "upload_mismatch"


def test_cannot_use_someone_elses_media(api, client, storage):
    owner, other = new_sub(), new_sub()
    api.me(owner)
    api.me(other)
    ticket = _ticket(client, owner).json()
    storage.objects[storage.presigned[0]] = StoredObject(byte_size=204_800, content_type="image/jpeg")
    client.post(f"/v1/media/{ticket['media_id']}/complete", headers=auth(owner))
    assert client.post(f"/v1/media/{ticket['media_id']}/complete", headers=auth(other)).status_code == 404
    r = client.post("/v1/posts", headers=auth(other), json={"caption": "stolen", "media_id": ticket["media_id"]})
    assert r.status_code == 422


def test_avatar_photo(api, client, storage):
    sub = new_sub()
    api.me(sub)
    ticket = _ticket(client, sub, purpose="avatar", content_type="image/png", byte_size=1000).json()
    storage.objects[storage.presigned[0]] = StoredObject(byte_size=1000, content_type="image/png")
    client.post(f"/v1/media/{ticket['media_id']}/complete", headers=auth(sub))
    r = client.patch("/v1/users/me/profile", headers=auth(sub), json={"avatar_media_id": ticket["media_id"]})
    assert r.status_code == 200 and r.json()["user"]["avatar_url"].endswith(".png")
    api.post(sub, caption="hi")
    assert api.feed(sub)["items"][0]["author"]["avatar_url"].endswith(".png")


def test_media_disabled_without_storage(settings, database, run_module):
    from fastapi.testclient import TestClient

    from app.main import create_app
    from app.services.media import DisabledStorage

    c = TestClient(create_app(settings, database=database, run_module=run_module, storage=DisabledStorage()))
    r = c.post("/v1/media/uploads", headers=auth(new_sub()), json={"purpose": "post", "content_type": "image/jpeg", "byte_size": 10})
    assert r.status_code == 503 and r.json()["code"] == "media_unavailable"

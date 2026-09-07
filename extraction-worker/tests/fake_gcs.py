"""
An in-memory stand-in for google.cloud.storage.Client.

Only the four methods storage.py actually calls are implemented --
bucket(), blob(), upload_from_string(), download_as_bytes(), exists().
Anything else raising AttributeError is a feature: it means the test
double stops matching the moment storage.py starts using a wider slice
of the GCS API than this fake was written against.

Deliberately NOT a mock with auto-specced attributes. A fake that stores
real bytes in a real dict can answer "does a round trip through GCS
return what I put in it", which is the actual question the compatibility
tests are asking. A mock can only answer "was upload_from_string
called".
"""


class FakeBlob:
    def __init__(self, store: dict, bucket: str, name: str):
        self._store = store
        self._key = (bucket, name)
        self.name = name
        self.content_type: str | None = None

    def upload_from_string(self, data, content_type=None):
        if isinstance(data, str):
            data = data.encode()
        self.content_type = content_type
        self._store[self._key] = (data, content_type)

    def download_as_bytes(self) -> bytes:
        if self._key not in self._store:
            raise KeyError(self._key)
        return self._store[self._key][0]

    def exists(self) -> bool:
        return self._key in self._store


class FakeBucket:
    def __init__(self, store: dict, name: str):
        self._store = store
        self.name = name

    def blob(self, name: str) -> FakeBlob:
        return FakeBlob(self._store, self.name, name)


class FakeGCSClient:
    """Shares one dict across every bucket/blob handle it hands out."""

    def __init__(self):
        self.store: dict[tuple[str, str], tuple[bytes, str | None]] = {}

    def bucket(self, name: str) -> FakeBucket:
        return FakeBucket(self.store, name)

    # -- helpers for assertions -------------------------------------------

    def objects_in(self, bucket: str) -> list[str]:
        return sorted(name for (b, name) in self.store if b == bucket)

    def content_type_of(self, bucket: str, name: str) -> str | None:
        return self.store[(bucket, name)][1]

from ..generate_ids import generate_id


def test_generate_id():
    # generate_id() should return a random hex string representing 16 bytes
    new_id: str = generate_id()
    new_bytes: bytes = bytes.fromhex(new_id)

    assert len(new_id) == 32
    assert len(new_bytes) == 16
    assert new_bytes.decode("utf-8") == new_id

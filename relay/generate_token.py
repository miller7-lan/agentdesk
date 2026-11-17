"""Create an independent device token and its registry digest on a trusted machine."""
import hashlib
import secrets


if __name__ == "__main__":
    token = secrets.token_urlsafe(32)
    print("token:", token)
    print("token_sha256:", hashlib.sha256(token.encode("ascii")).hexdigest())

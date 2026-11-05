"""Typed request errors mapped to HTTP status codes by the app."""

from __future__ import annotations


class MlError(Exception):
    status = 400
    code = "bad_request"

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class InvalidInput(MlError):
    status = 422
    code = "invalid_input"


class TooLarge(MlError):
    status = 413
    code = "too_large"


class NotFound(MlError):
    status = 404
    code = "not_found"


class Forbidden(MlError):
    status = 403
    code = "path_forbidden"


class Unavailable(MlError):
    status = 503
    code = "unavailable"

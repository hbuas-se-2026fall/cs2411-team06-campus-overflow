import pytest
from pydantic import ValidationError

from app.core.config import DEFAULT_JWT_SECRET, Settings

VALID_DB = "mysql+pymysql://root:strong-db-password-123@db:3306/campus_overflow?charset=utf8mb4"
VALID_SECRET = "k" * 48


def _prod(**overrides):
    values = {
        "_env_file": None,
        "debug": False,
        "database_url": VALID_DB,
        "jwt_secret": VALID_SECRET,
    }
    values.update(overrides)
    return Settings(**values)


def test_debug_allows_development_defaults():
    settings = Settings(_env_file=None, debug=True)
    assert settings.jwt_secret == DEFAULT_JWT_SECRET


def test_production_rejects_default_or_short_jwt_secret():
    with pytest.raises(ValidationError, match="JWT"):
        _prod(jwt_secret=DEFAULT_JWT_SECRET)
    with pytest.raises(ValidationError, match="JWT"):
        _prod(jwt_secret="k" * 31)


def test_production_rejects_default_or_weak_database_password():
    with pytest.raises(ValidationError, match="BACKEND_DATABASE_URL"):
        _prod(database_url="mysql+pymysql://root:root@db:3306/campus_overflow")
    with pytest.raises(ValidationError, match="BACKEND_DATABASE_URL"):
        _prod(database_url="mysql+pymysql://root:short@db:3306/campus_overflow")


def test_production_accepts_strong_secrets():
    settings = _prod()
    assert settings.jwt_secret == VALID_SECRET

"""Native CLI configuration serialization shared by launch integrations."""

import json


def toml(value):
    """Serialize the small JSON-shaped subset used by native CLI overrides."""
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, list):
        return '[' + ','.join(map(toml, value)) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(toml(k) + '=' + toml(v) for k, v in value.items()) + '}'
    raise ValueError('Unsupported CLI configuration value')

"""Imports the layer module from /opt/python and runs the /opt/bin tool."""

import json
import os
import subprocess

import layer_tool


def handler(event, context):
    tool = subprocess.run(
        ["layer-tool"], capture_output=True, text=True, check=True
    ).stdout.strip()
    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(
            {
                "greeting": layer_tool.message(),
                "tool": tool,
                "optPython": "/opt/python" in os.environ.get("PYTHONPATH", "").split(os.pathsep),
                "optBin": "/opt/bin" in os.environ.get("PATH", "").split(os.pathsep),
                "optLib": "/opt/lib" in os.environ.get("LD_LIBRARY_PATH", "").split(os.pathsep),
            }
        ),
    }

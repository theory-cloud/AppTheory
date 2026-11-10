#!/usr/bin/env python3
"""LOCAL-W3-X5 row: the 'genuine-replay' refresh sequence over real HTTP.

The examples harness runs this script against the example app; a developer can
run it against any running instance:

    python3 scripts/genuine-replay.py --base-url https://mcp.localhost:8240 --ca <run ca.pem>
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from replay_lib import main_for

raise SystemExit(main_for("genuine-replay"))

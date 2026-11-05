# Lab 4 submission

Upload to **Lab 4 report** on Moodle (each partner, under their own name):

- `SPEC.md`: the final spec
- `spec-history.md`: what changed in each spec commit and why, plus findings in the traffic

Also here, for showing the work:

- `build-02/`: the last build, made from scratch by a fresh agent from `SPEC.md` and `proxy.py` only.
  Run: `python3 proxy.py`, then `python3 dashboard/server.py --log traffic.jsonl` (http://localhost:8042).
- `traffic/`: captured sessions to load with `--log` (added once the repo is private, since they hold full prompts).

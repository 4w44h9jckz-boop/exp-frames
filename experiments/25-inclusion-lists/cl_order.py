"""Experiment 25: the order in which the consensus layer hands inclusion-list transactions over.

`get_inclusion_list_transactions` below is consensus-specs' function as written in
specs/heze/inclusion-list.md (master, read 2026-10-08), with its store reduced to the two
fields it reads. Its last line deduplicates through a Python set, and the specification adds:
"Order does not need to be preserved." In CPython the iteration order of a set of bytes follows
the per-process hash seed, so the reference implementation itself delivers the same lists in a
different order from one process to the next.

Run (PYTHONHASHSEED must reach the interpreter, so no -I or -E):
  for s in 0 1 2 3 4 5 6 7; do PYTHONHASHSEED=$s python3 experiments/25-inclusion-lists/cl_order.py mixed; done
It prints a scenario block in the format ethrex/exp25_fill_order.rs reads, one fixed order. A
scenario whose lines are split by "-- list" gives each committee member's list; otherwise two
members list the scenario's transactions, the second in reverse.
"""
import os
import sys
from dataclasses import dataclass, field

HERE = os.path.dirname(os.path.abspath(__file__))


@dataclass
class InclusionListMessage:
    transactions: list


@dataclass
class SignedInclusionList:
    message: InclusionListMessage


@dataclass
class InclusionListEntry:
    signed_inclusion_list: SignedInclusionList
    timely: bool


@dataclass
class InclusionListStore:
    inclusion_lists: dict = field(default_factory=dict)
    equivocators: dict = field(default_factory=dict)


def get_inclusion_list_transactions(store, slot, dependent_root, only_timely=True):
    # Verbatim from specs/heze/inclusion-list.md, types elided.
    key = (slot, dependent_root)
    inclusion_lists = store.inclusion_lists[key]
    equivocators = store.equivocators[key]

    transactions = []
    for validator_index, inclusion_list in inclusion_lists.items():
        # Ignore inclusion lists from equivocators
        if validator_index in equivocators:
            continue

        # Ignore untimely inclusion lists if only timely ones are requested
        if only_timely and not inclusion_list.timely:
            continue

        transactions.extend(inclusion_list.signed_inclusion_list.message.transactions)

    # Deduplicate inclusion list transactions. Order does not need to be preserved.
    return list(set(transactions))


def main():
    scenario = sys.argv[1]
    rows, lists, current = {}, [[]], None
    with open(os.path.join(HERE, "ethrex", "scenarios.txt")) as f:
        for line in f:
            line = line.rstrip("\n")
            if line.startswith("scenario "):
                current = line[len("scenario "):]
                continue
            if current != scenario or not line or line.startswith("#"):
                continue
            if line == "-- list":
                lists.append([])
                continue
            label, raw, _note = line.split(" ", 2)
            tx = bytes.fromhex(raw[2:])
            rows[tx] = (label, raw)
            lists[-1].append(tx)
    if len(lists) == 1:
        # One list in the file: two committee members list it, the second in reverse.
        lists = [lists[0], list(reversed(lists[0]))]
    store = InclusionListStore()
    key = (1, b"\x00" * 32)
    store.inclusion_lists[key] = {
        7 + 2 * i: InclusionListEntry(SignedInclusionList(InclusionListMessage(txs)), True)
        for i, txs in enumerate(lists)
    }
    store.equivocators[key] = set()
    delivered = get_inclusion_list_transactions(store, 1, b"\x00" * 32)
    seed = os.environ.get("PYTHONHASHSEED", "random")
    print(f"scenario as-delivered {scenario} PYTHONHASHSEED={seed}")
    for tx in delivered:
        label, raw = rows[tx]
        print(f"{label} {raw} delivered")


main()

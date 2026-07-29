# S05 Assignment-driven CLI convergence

User outcome: one guarded CLI loop starts, resumes, completes, recovers, and
observes several durable prompt Graphs without manually selecting runtime
nodes or calling unlock transitions.

Depends on S04. Covers UP01 through UP04 and extends S01 runtime BDD with
Assignment identity, automatic scheduling, JSON Help, filtered inspection, and
named Viewer lifecycle.

Done When the source and isolated installed CLI both converge a bounded repair
loop and parallel multi-Graph workload, every public command is discoverable
through JSON Help, legacy commands fail, and the Viewer remains read-only.
The normal loop stays bounded and the cold 500-Task start regression Gate
remains below 1,000 ms on the registered local fixture.

Feature: Durable AI-operated prompt graphs

  Scenario: Parallel tasks converge through a join
    Given a valid graph whose Start fans out to two Tasks and then a Join
    When one Actor starts the Run and receives both prompt Assignments
    And it completes both Assignments
    Then the Join completes only after both activated branches settle
    And the downstream Assignment is returned exactly once

  Scenario: Decision selects one bounded route
    Given a running Decision with pass and repair routes
    When its actor completes it with route repair
    Then the repair edge is taken
    And the pass edge is disabled for that attempt
    And selecting repair beyond its maxTraversals is rejected

  Scenario: Concurrent scheduling is atomic
    Given one Ready Task
    When two processes request Next concurrently
    Then both responses are valid
    And exactly one response contains the live Assignment

  Scenario: Actor concurrency remains bounded
    Given more than eight Ready nodes across active Runs
    When several Next processes schedule for one Actor concurrently
    Then that Actor owns at most eight live Assignments
    And every excess Ready node remains unclaimed

  Scenario: Completion advances and is idempotent
    Given a live Assignment with a valid completion document
    When its Actor reports Done
    Then legal structural transitions are resolved automatically
    And zero or more complete successor Assignments are returned
    When the Actor repeats the same completion document
    Then the same completion receipt is returned without a new event
    But a different completion document is rejected as a conflict

  Scenario: Stale recovery cannot mutate a later Attempt
    Given Attempt 1 was blocked, unblocked, and replaced by blocked Attempt 2
    When the Actor unblocks with the Assignment ID from Attempt 1
    Then the command is rejected as ASSIGNMENT_STALE
    And Attempt 2 remains Blocked

  Scenario: Runtime resumes after restart
    Given multiple graphs with persisted attempts and events
    When every burn-graph process exits and a new process starts
    Then a snapshot contains the same graph and node state
    And Current recovers complete live Assignment packets
    And expired Assignments can be reconciled without losing prior Attempts

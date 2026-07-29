Feature: Durable AI-operated prompt graphs

  Scenario: Parallel tasks converge through a join
    Given a valid graph whose Start fans out to two Tasks and then a Join
    When different actors complete both Tasks
    Then the Join completes only after both activated branches settle
    And the downstream node becomes Ready exactly once

  Scenario: Decision selects one bounded route
    Given a running Decision with pass and repair routes
    When its actor completes it with route repair
    Then the repair edge is taken
    And the pass edge is disabled for that attempt
    And selecting repair beyond its maxTraversals is rejected

  Scenario: Concurrent claims are atomic
    Given one Ready Task
    When two processes claim it concurrently
    Then exactly one claim succeeds
    And the other response is a retryable state conflict

  Scenario: Runtime resumes after restart
    Given multiple graphs with persisted attempts and events
    When every burn-graph process exits and a new process starts
    Then a snapshot contains the same graph and node state
    And expired claims can be reconciled without losing prior Attempts

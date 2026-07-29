Feature: Read-only live graph overview

  Scenario: Human sees the canonical state
    Given a project with Ready, Running, Done, and Blocked nodes
    When the human opens the local Viewer
    Then every graph summary matches the public CLI snapshot
    And Mermaid nodes use the status styles defined by the design system

  Scenario: Viewer receives a live transition
    Given the Viewer has loaded an event cursor
    When an AI completes a node through the CLI
    Then the Viewer updates without a page refresh
    And reconnecting from the cursor does not duplicate or lose the transition

  Scenario: Browser cannot mutate state
    Given the Viewer is running
    When a client uses every documented HTTP route
    Then no route can create, schedule, complete, fail, or delete graph state

  Scenario: Named Viewer lifecycle owns one exact process
    Given two Viewer names use distinct loopback ports
    When the operator starts, checks, and stops one name
    Then health is reported only for its recorded PID
    And the other process is not signalled

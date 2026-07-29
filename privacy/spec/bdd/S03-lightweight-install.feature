Feature: Lightweight burn-graph installation

  Scenario: Release archive runs outside the source tree
    Given a release archive containing the bundled CLI and Viewer
    And Bun 1.2.17 or newer
    When the archive is installed into an isolated global prefix
    Then it declares zero package dependencies
    And the burn-graph command reports its version with exit code zero
    And the source package manifest and lockfile remain unchanged
    And separate installed CLI processes schedule parallel Assignments safely
    And the installed Viewer serves packaged assets through read-only routes

  Scenario: Product data remains project-local
    Given burn-graph was installed through Bun's global package directory
    When the user initializes and advances a graph in an unrelated project
    Then definitions and runtime state are written only beneath that project
    And reinstalling or removing the package does not own that project data

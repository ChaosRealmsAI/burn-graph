# F0002 — Replace Docker installation with the lightest path

The user rejected Docker as too heavy and asked for the fastest practical
installation.

Resolution target: ship the bundled CLI and Viewer as a small Bun global
package with zero package dependencies, one install command, and a real
isolated-prefix E2E. Docker is not a product installation or release Gate.

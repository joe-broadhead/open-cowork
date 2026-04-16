# Desktop App Guide

## Main sections

The desktop app is centered around four areas:
- `Home`
- `Chat`
- `Agents`
- `Capabilities`

## Home

The home page mixes:
- runtime health
- capability inventory
- agent inventory
- recent work
- usage summaries

Usage summaries are history-backed and support time ranges such as:
- last 7 days
- last 30 days
- year to date
- all time

## Chat

Chat is where OpenCode sessions run.

Important behavior:
- `@agent` selects a target agent for the prompt
- skills are OpenCode-native and are not invoked through a custom `$skill` syntax
- streamed text, tool calls, approvals, and task runs are projected into a UI-safe session model

## Project vs sandbox threads

### Project thread

A project thread is bound to a real directory and is appropriate for:
- code generation
- file editing
- repository work

### Sandbox thread

A sandbox thread uses a private Cowork-managed workspace and surfaces outputs as artifacts.

This is appropriate for:
- generated reports
- drafts
- charts
- private experimentation

## Artifacts

Sandbox-generated files are treated as artifacts first.

Artifact actions include:
- save as
- reveal in Finder/file manager
- storage cleanup from Settings

## Agents

The Agents page lets users:
- inspect built-in agents
- create custom agents
- bind custom agents to specific tools and skills

Custom agents compile into OpenCode-native agent configuration rather than a parallel Open Cowork execution system.

## Capabilities

The Capabilities page lets users inspect:
- built-in tools
- custom tools from MCPs
- bundled skills
- custom skills

This page is the main visibility surface for the tool and skill catalog.

## Settings

Settings currently cover:
- appearance
- models
- permissions
- sandbox storage

The storage section reports sandbox usage and provides cleanup controls for old or unused sandbox workspaces.

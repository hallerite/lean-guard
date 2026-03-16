# lean-guard

OpenCode plugin that prevents an agent from modifying the theorem statement in a Lean 4 proof file. Designed to block reward hacking during RL rollouts where the agent might rewrite the theorem to make it trivially provable.

## How it works

The plugin looks for **marker comments** in the proof file that delimit the protected region — only the theorem signature, not imports:

```lean
import Mathlib

-- lean-guard: begin protected
theorem foo : 1 + 1 = 2 := by
-- lean-guard: end protected
  sorry
```

Everything between (and including) the markers is immutable. The agent can freely modify imports, add helper lemmas, open namespaces, etc. — but cannot rewrite the theorem statement itself.

No config files needed — the markers in the file are the entire source of truth.

### Preventive hooks (`tool.execute.before`)

| Tool | Blocked when |
|------|-------------|
| `write` | Targets a file containing guard markers |
| `edit` | `oldString` falls within the protected region |
| `bash` | Contains redirects, `sed -i`, `tee`, `cp`, or `mv` targeting a guarded file |
| `apply_patch` | Mentions a guarded file path |

### Safety net (`tool.execute.after`)

After any `edit`, `bash`, or `write`, the plugin re-reads guarded files and verifies the protected region is unchanged. If tampered, the file is reset to `<protected region> + "  sorry\n"` and the agent receives an error message explaining the revert.

## Usage

The `opencode_lean` environment injects the markers into proof files and uploads this plugin into sandboxes automatically. No build step needed — opencode's Bun runtime executes `.ts` directly.

### Standalone testing

```bash
# In a lean-tactic container with opencode installed:
cat > /tmp/proof.lean << 'EOF'
import Mathlib

-- lean-guard: begin protected
theorem foo : 1 + 1 = 2 := by
-- lean-guard: end protected
  sorry
EOF

cp /path/to/lean-guard/src/index.ts ~/.config/opencode/plugins/lean-guard.ts
opencode run "Prove the theorem in /tmp/proof.lean"
```

## Integration

Used by [`opencode_lean`](https://github.com/PrimeIntellect-ai/research-environments) — the environment sets `lean_guard_plugin_path` (default `~/lean-guard/src/index.ts`) and uploads the file into each sandbox at `/root/.config/opencode/plugins/lean-guard.ts`.

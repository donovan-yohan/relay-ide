// #732: view-spine MVP placeholder. Flag-gated (default OFF) sidebar body.
// The client-derived read-only tree (#729) replaces this stub in the next
// commit. Kept intentionally minimal so the OFF render path is untouched.
export function ViewSpineTree() {
  return (
    <div className="sidebar-empty-state">
      <span>view-spine (coming soon)</span>
    </div>
  );
}

export default ViewSpineTree;

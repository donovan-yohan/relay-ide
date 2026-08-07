import { useQuery } from '@tanstack/react-query';
import { fetchHubNodes } from '../lib/api.js';
import { selectProdTierNodes } from '../lib/state/node-dashboard.js';
import './ProdTrustBanner.css';

export function ProdTrustBanner() {
  const { data: nodes, isError } = useQuery({
    queryKey: ['hub-nodes'],
    queryFn: fetchHubNodes,
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
    retry: 1,
  });

  if (isError) {
    return (
      <div className="prod-trust-banner prod-trust-banner--unknown" role="status">
        <span className="prod-trust-banner-glyph" aria-hidden="true">[?]</span>
        <span className="prod-trust-banner-text">
          could not verify node attachment status · treat destructive actions as if a prod node may be attached
        </span>
      </div>
    );
  }

  const prodNodes = selectProdTierNodes(nodes ?? []);

  if (prodNodes.length === 0) return null;

  return (
    <div className="prod-trust-banner" role="status">
      <span className="prod-trust-banner-glyph" aria-hidden="true">[!]</span>
      <span className="prod-trust-banner-text">
        prod-tier node{prodNodes.length > 1 ? 's' : ''} attached:{' '}
        {prodNodes.map((n) => n.displayName ?? n.nodeId).join(', ')} ·
        destructive capabilities require confirmation
      </span>
    </div>
  );
}

export default ProdTrustBanner;

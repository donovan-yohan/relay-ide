import React, { useEffect, useState } from 'react';
import CipherText from '../../CipherText.js';
import IntegrationRow from './IntegrationRow.js';
import './JiraIntegration.css';

export default function JiraIntegration() {
  const [expanded, setExpanded] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/integration-jira/configured');
        if (res.status === 404) {
          setConfigured(null);
          setLoading(false);
          return;
        }
        const data = (await res.json()) as { configured?: boolean };
        setConfigured(data.configured ?? false);
      } catch {
        setConfigured(false);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  let statusText: string;
  if (loading) {
    statusText = 'Checking...';
  } else if (configured === null) {
    statusText = 'Not available';
  } else if (configured) {
    statusText = 'Connected';
  } else {
    statusText = 'CLI not installed';
  }

  return (
    <IntegrationRow
      name="Jira"
      statusText={statusText}
      connected={configured === true}
      loading={loading}
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {loading ? (
        <CipherText loading={true} text="Loading tickets..." />
      ) : configured === null ? (
        <p className="jira-integration-body-text jira-integration-body-text--muted">
          Jira integration is not available on this server.
        </p>
      ) : configured ? (
        <>
          <p className="jira-integration-body-text jira-integration-body-text--success">
            Connected via Atlassian CLI
          </p>
          <p className="jira-integration-body-text jira-integration-body-text--muted">
            Jira tickets appear automatically in the sidebar.
          </p>
        </>
      ) : (
        <>
          <p className="jira-integration-body-text jira-integration-body-text--muted">
            Install the Atlassian CLI to see your Jira tickets.
          </p>
          <ol className="jira-integration-steps">
            <li className="jira-integration-step">
              <span className="jira-integration-step-number">1.</span>
              <code className="jira-integration-code-block">
                brew tap atlassian/tap &amp;&amp; brew install acli
              </code>
            </li>
            <li className="jira-integration-step">
              <span className="jira-integration-step-number">2.</span>
              <code className="jira-integration-code-block">acli jira auth login --web</code>
            </li>
            <li className="jira-integration-step">
              <span className="jira-integration-step-number">3.</span>
              <code className="jira-integration-code-block">Refresh this page</code>
            </li>
          </ol>
          <p className="jira-integration-body-text jira-integration-body-text--muted">
            The CLI handles authentication — no API tokens needed.
          </p>
        </>
      )}
    </IntegrationRow>
  );
}

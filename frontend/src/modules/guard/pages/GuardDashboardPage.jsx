import { useEffect, useState } from "react";
import { getGuardDashboard, searchGuard } from "../api.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { SearchField } from "../../../shared/components/SearchField.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";
import { GuardPassList } from "../components/GuardPassList.jsx";
import { useDebouncedValue } from "../../../shared/hooks/useDebouncedValue.js";
import styles from "./GuardDashboardPage.module.css";

export function GuardDashboardPage() {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);

  const [dashboard, setDashboard] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);

  const [searchResults, setSearchResults] = useState(null);
  const [searchStatus, setSearchStatus] = useState("idle");

  useEffect(() => {
    let cancelled = false;

    getGuardDashboard()
      .then((response) => {
        if (!cancelled) {
          setDashboard(response.data);
          setStatus("ready");
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(requestError.message || "Unable to load the gate dashboard.");
          setStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (debouncedQuery.trim().length < 2) {
      // Needed on every query change back below the threshold, not just
      // mount, so lazy initial state can't substitute for this.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearchResults(null);
      setSearchStatus("idle");
      return undefined;
    }

    let cancelled = false;
    setSearchStatus("loading");

    searchGuard(debouncedQuery.trim())
      .then((response) => {
        if (!cancelled) {
          setSearchResults(response.data);
          setSearchStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setSearchStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const isSearching = debouncedQuery.trim().length >= 2;

  return (
    <div>
      <PageHeader title="Gate" description="Verify, exit, and return Gate Passes." />

      <div className={styles.searchSection}>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search by Gate Pass #, vehicle, or driver"
          ariaLabel="Search Gate Passes"
        />
      </div>

      {isSearching ? (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Search Results</h2>
          {searchStatus === "loading" && <LoadingState message="Searching…" />}
          {searchStatus === "error" && <ErrorState message="Unable to search right now." />}
          {searchStatus === "ready" && (
            <GuardPassList rows={searchResults} emptyMessage="No matching approved or outside Gate Passes." />
          )}
        </div>
      ) : (
        <>
          {status === "loading" && <LoadingState message="Loading gate dashboard…" />}
          {status === "error" && <ErrorState message={error} />}
          {status === "ready" && (
            <>
              <div className={styles.section}>
                <h2 className={styles.sectionTitle}>Newly Approved</h2>
                <GuardPassList rows={dashboard.newlyApproved} emptyMessage="Nothing newly approved." />
              </div>
              <div className={styles.section}>
                <h2 className={styles.sectionTitle}>Vehicles Outside</h2>
                <GuardPassList rows={dashboard.vehiclesOutside} emptyMessage="No vehicles currently outside." />
              </div>
              <div className={styles.section}>
                <h2 className={styles.sectionTitle}>Recent Activity</h2>
                <GuardPassList rows={dashboard.recentActivity} emptyMessage="No recent activity yet." />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

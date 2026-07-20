// Season Selector - Shared across all pages
(function() {
    const STORAGE_KEY = 'fpl-selected-season';

    // Get currently selected season from localStorage
    function getSelectedSeason() {
        return localStorage.getItem(STORAGE_KEY) || null;
    }

    // Set selected season
    function setSelectedSeason(season) {
        if (season) {
            localStorage.setItem(STORAGE_KEY, season);
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    }

    // Get season parameter for API calls
    window.getSeasonParam = function() {
        const season = getSelectedSeason();
        return season ? `?season=${season}` : '';
    };

    // Append season to URL
    window.appendSeasonParam = function(url) {
        const season = getSelectedSeason();
        if (!season) return url;
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}season=${season}`;
    };

    // Check if viewing current season
    window.isCurrentSeason = function() {
        return !getSelectedSeason();
    };

    // Create and inject the season selector UI
    async function initSeasonSelector() {
        // Fetch available seasons
        let seasons = [];
        let currentSeason = '';
        try {
            const res = await fetch('/api/seasons');
            const data = await res.json();
            seasons = data.seasons || [];
            currentSeason = data.currentSeason;
        } catch (e) {
            console.error('Failed to fetch seasons:', e);
            return;
        }

        // Only show selector if there are archived seasons
        const selectedSeason = getSelectedSeason();
        const displaySeason = selectedSeason || currentSeason;

        // Create the season selector button
        const selectorHtml = `
            <div class="season-selector">
                <button class="season-btn" onclick="openSeasonModal()">
                    <span class="season-icon">📅</span>
                    <span class="season-label">${displaySeason}</span>
                    <span class="season-arrow">▼</span>
                </button>
            </div>
        `;

        // Create the modal
        const modalHtml = `
            <div class="season-modal-overlay" id="seasonModal" onclick="closeSeasonModal(event)">
                <div class="season-modal" onclick="event.stopPropagation()">
                    <div class="season-modal-header">
                        <h3>Select Season</h3>
                        <button class="season-modal-close" onclick="closeSeasonModal()">&times;</button>
                    </div>
                    <div class="season-modal-body">
                        ${seasons.map(s => `
                            <button class="season-option ${s.id === displaySeason ? 'active' : ''}"
                                    onclick="selectSeason('${s.isCurrent ? '' : s.id}')">
                                <span class="season-option-label">${s.label}</span>
                                ${s.isCurrent ? '<span class="season-option-badge">Live</span>' : ''}
                            </button>
                        `).join('')}
                    </div>
                </div>
            </div>
        `;

        // Inject styles
        const styles = `
            <style>
                .season-selector {
                    display: flex;
                    justify-content: center;
                    margin: -0.5rem 0 1rem;
                }

                .season-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                    background: rgba(255, 255, 255, 0.1);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    color: var(--gray-300, #ccc);
                    padding: 0.5rem 1rem;
                    border-radius: 20px;
                    font-size: 0.85rem;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .season-btn:hover {
                    background: rgba(255, 255, 255, 0.15);
                    border-color: var(--accent, #00ff87);
                }

                .season-icon {
                    font-size: 1rem;
                }

                .season-label {
                    font-weight: 600;
                }

                .season-arrow {
                    font-size: 0.7rem;
                    opacity: 0.7;
                }

                /* Modal Overlay */
                .season-modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.8);
                    display: none;
                    align-items: center;
                    justify-content: center;
                    z-index: 2000;
                    padding: 1rem;
                }

                .season-modal-overlay.active {
                    display: flex;
                }

                .season-modal {
                    background: var(--gray-900, #1a1a2e);
                    border-radius: 12px;
                    width: 100%;
                    max-width: 320px;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    overflow: hidden;
                }

                .season-modal-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 1rem 1.25rem;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                }

                .season-modal-header h3 {
                    margin: 0;
                    font-size: 1.1rem;
                    color: var(--white, #fff);
                }

                .season-modal-close {
                    background: none;
                    border: none;
                    color: var(--gray-400, #999);
                    font-size: 1.5rem;
                    cursor: pointer;
                    padding: 0;
                    line-height: 1;
                }

                .season-modal-close:hover {
                    color: var(--white, #fff);
                }

                .season-modal-body {
                    padding: 0.5rem;
                }

                .season-option {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    width: 100%;
                    padding: 0.85rem 1rem;
                    background: transparent;
                    border: none;
                    color: var(--gray-300, #ccc);
                    font-size: 0.95rem;
                    cursor: pointer;
                    border-radius: 8px;
                    transition: all 0.2s;
                    text-align: left;
                }

                .season-option:hover {
                    background: rgba(255, 255, 255, 0.1);
                }

                .season-option.active {
                    background: rgba(0, 255, 135, 0.15);
                    color: var(--accent, #00ff87);
                }

                .season-option-badge {
                    background: var(--accent, #00ff87);
                    color: var(--gray-900, #1a1a2e);
                    padding: 0.2rem 0.5rem;
                    border-radius: 10px;
                    font-size: 0.7rem;
                    font-weight: 700;
                    text-transform: uppercase;
                }

                /* Viewing past season banner */
                .past-season-banner {
                    background: linear-gradient(90deg, #f39c12, #e67e22);
                    color: #fff;
                    text-align: center;
                    padding: 0.5rem;
                    font-size: 0.85rem;
                    font-weight: 600;
                }

                .past-season-banner a {
                    color: #fff;
                    text-decoration: underline;
                    margin-left: 0.5rem;
                }
            </style>
        `;

        // Inject into page
        document.head.insertAdjacentHTML('beforeend', styles);
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // Find the page header and insert selector after it
        const pageHeader = document.querySelector('.page-header');
        const hero = document.querySelector('.hero');

        if (pageHeader) {
            pageHeader.insertAdjacentHTML('afterend', selectorHtml);
        } else if (hero) {
            hero.insertAdjacentHTML('afterend', selectorHtml);
        }

        // Show banner if viewing past season
        if (selectedSeason) {
            const banner = `
                <div class="past-season-banner">
                    Viewing archived data from ${selectedSeason}
                    <a href="#" onclick="selectSeason(''); return false;">Return to current season</a>
                </div>
            `;
            document.body.insertAdjacentHTML('afterbegin', banner);
        }
    }

    // Modal controls
    window.openSeasonModal = function() {
        document.getElementById('seasonModal').classList.add('active');
    };

    window.closeSeasonModal = function(event) {
        if (event && event.target !== event.currentTarget) return;
        document.getElementById('seasonModal').classList.remove('active');
    };

    window.selectSeason = function(season) {
        setSelectedSeason(season);
        window.location.reload();
    };

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modal = document.getElementById('seasonModal');
            if (modal) modal.classList.remove('active');
        }
    });

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSeasonSelector);
    } else {
        initSeasonSelector();
    }
})();

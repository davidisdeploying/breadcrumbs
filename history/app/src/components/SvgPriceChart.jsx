import React from 'react';

function formatCents(cents) {
  if (cents == null) return '-';
  return `$${(cents / 100).toFixed(2)}`;
}

export function SvgPriceChart({ observations = [], minCents, medianCents, maxCents }) {
  if (!observations || observations.length === 0) {
    return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--crust)' }}>No price observations available.</div>;
  }

  const svgWidth = 800;
  const svgHeight = 240;
  const padding = { top: 30, right: 90, bottom: 40, left: 40 };

  const chartW = svgWidth - padding.left - padding.right;
  const chartH = svgHeight - padding.top - padding.bottom;

  // Extract all paid_unit_cents
  // paid_unit_cents = Math.round(line_total_cents / qty) is the ONLY authoritative price signal.
  const prices = observations.map((o) => o.paid_unit_cents);
  const minVal = Math.min(...prices, minCents ?? Infinity);
  const maxVal = Math.max(...prices, maxCents ?? -Infinity);

  const priceRange = maxVal === minVal ? (maxVal > 0 ? maxVal * 0.2 : 100) : (maxVal - minVal);
  const yMin = Math.max(0, minVal - priceRange * 0.15);
  const yMax = maxVal + priceRange * 0.15;

  const getY = (cents) => {
    if (yMax === yMin) return padding.top + chartH / 2;
    const ratio = (cents - yMin) / (yMax - yMin);
    return padding.top + chartH - ratio * chartH;
  };

  const getX = (index) => {
    if (observations.length === 1) return padding.left + chartW / 2;
    return padding.left + (index / (observations.length - 1)) * chartW;
  };

  // Generate points string
  const points = observations.map((obs, i) => `${getX(i)},${getY(obs.paid_unit_cents)}`).join(' ');

  return (
    <div className="chart-container">
      <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} style={{ width: '100%', height: '100%' }}>
        {/* Background grid lines */}
        <line x1={padding.left} y1={padding.top} x2={svgWidth - padding.right} y2={padding.top} stroke="var(--line)" strokeDasharray="3 3" opacity="0.5" />
        <line x1={padding.left} y1={padding.top + chartH} x2={svgWidth - padding.right} y2={padding.top + chartH} stroke="var(--line)" opacity="0.8" />

        {/* Median Reference Line */}
        {medianCents != null && (
          <g>
            <line
              x1={padding.left}
              y1={getY(medianCents)}
              x2={svgWidth - padding.right}
              y2={getY(medianCents)}
              stroke="var(--crust)"
              strokeDasharray="4 4"
              strokeWidth="1.5"
            />
            <text
              x={svgWidth - padding.right + 8}
              y={getY(medianCents) + 4}
              fill="var(--crust)"
              fontFamily="Space Mono"
              fontSize="12"
              fontWeight="bold"
            >
              med {formatCents(medianCents)}
            </text>
          </g>
        )}

        {/* Min Reference Line */}
        {minCents != null && minCents !== medianCents && (
          <g>
            <line
              x1={padding.left}
              y1={getY(minCents)}
              x2={svgWidth - padding.right}
              y2={getY(minCents)}
              stroke="var(--green)"
              strokeDasharray="2 2"
              opacity="0.7"
            />
            <text
              x={svgWidth - padding.right + 8}
              y={getY(minCents) + 4}
              fill="var(--green)"
              fontFamily="Space Mono"
              fontSize="11"
            >
              min {formatCents(minCents)}
            </text>
          </g>
        )}

        {/* Max Reference Line */}
        {maxCents != null && maxCents !== medianCents && maxCents !== minCents && (
          <g>
            <line
              x1={padding.left}
              y1={getY(maxCents)}
              x2={svgWidth - padding.right}
              y2={getY(maxCents)}
              stroke="var(--high)"
              strokeDasharray="2 2"
              opacity="0.7"
            />
            <text
              x={svgWidth - padding.right + 8}
              y={getY(maxCents) + 4}
              fill="var(--high)"
              fontFamily="Space Mono"
              fontSize="11"
            >
              max {formatCents(maxCents)}
            </text>
          </g>
        )}

        {/* Paid Unit Cents Price Line Segments */}
        {observations.length > 1 &&
          observations.map((obs, i) => {
            if (i === 0) return null;
            const prevObs = observations[i - 1];
            const x1 = getX(i - 1);
            const y1 = getY(prevObs.paid_unit_cents);
            const x2 = getX(i);
            const y2 = getY(obs.paid_unit_cents);
            const sameBasis = (prevObs.unit_basis || 'package') === (obs.unit_basis || 'package');

            return (
              <line
                key={`line-${i}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={sameBasis ? 'var(--ink)' : 'var(--high)'}
                strokeWidth={sameBasis ? '3' : '2'}
                strokeDasharray={sameBasis ? undefined : '5 4'}
                strokeLinecap="round"
              />
            );
          })}

        {/* Data points */}
        {observations.map((obs, i) => {
          const cx = getX(i);
          const cy = getY(obs.paid_unit_cents);
          const isWeight = obs.unit_basis === 'weight_each';

          return (
            <g key={obs.id || i} className="chart-point">
              {isWeight ? (
                <rect
                  x={cx - 5}
                  y={cy - 5}
                  width="10"
                  height="10"
                  fill="var(--ink)"
                  stroke="var(--paper)"
                  strokeWidth="2"
                />
              ) : (
                <circle
                  cx={cx}
                  cy={cy}
                  r="5"
                  fill="var(--ink)"
                  stroke="var(--paper)"
                  strokeWidth="2"
                />
              )}
              <title>{`${obs.observed_on || 'Date'}: ${formatCents(obs.paid_unit_cents)} (${obs.unit_basis || 'package'})`}</title>
            </g>
          );
        })}

        {/* X-axis date labels for first & last */}
        {observations.length > 0 && (
          <>
            <text
              x={padding.left}
              y={svgHeight - 10}
              fill="var(--char)"
              fontFamily="Space Mono"
              fontSize="12"
            >
              {observations[0].observed_on}
            </text>
            {observations.length > 1 && (
              <text
                x={svgWidth - padding.right}
                y={svgHeight - 10}
                textAnchor="end"
                fill="var(--char)"
                fontFamily="Space Mono"
                fontSize="12"
              >
                {observations[observations.length - 1].observed_on}
              </text>
            )}
          </>
        )}
      </svg>
    </div>
  );
}

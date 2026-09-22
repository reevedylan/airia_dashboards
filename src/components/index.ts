/**
 * viz-kit — dependency-free chart components.
 *
 * Every visual value comes from `src/theme/tokens.css`. Copy that file plus
 * this folder into another project and the kit travels with its palette.
 */

export { Card, AxisExtent } from './primitives/Card'
export type { CardProps } from './primitives/Card'
export { Legend } from './primitives/Legend'
export type { LegendItem, LegendProps } from './primitives/Legend'
export { Tooltip } from './primitives/Tooltip'
export type { TooltipRow, TooltipProps } from './primitives/Tooltip'
export { TableView } from './primitives/TableView'
export type { TableColumn, TableViewProps } from './primitives/TableView'
export { StatTile } from './primitives/StatTile'
export type { StatTileProps } from './primitives/StatTile'
export { TimeRangeBar, ToolbarButton, FilterIcon, SavedIcon, RANGES } from './primitives/TimeRangeBar'
export type { RangeKey, TimeRangeBarProps } from './primitives/TimeRangeBar'

export { LineChart } from './charts/LineChart'
export type { LineChartProps, LineSeries } from './charts/LineChart'
export { BarChart } from './charts/BarChart'
export type { BarChartProps, BarSeries } from './charts/BarChart'
export { DonutChart } from './charts/DonutChart'
export type { DonutChartProps, DonutSlice } from './charts/DonutChart'
export { RankTable } from './charts/RankTable'
export type { RankTableProps, RankRow, RankColumn } from './charts/RankTable'
export { Sparkline } from './charts/Sparkline'
export type { SparklineProps } from './charts/Sparkline'

export * as palette from '../theme/palette'
export * as format from '../lib/format'
export * as scale from '../lib/scale'

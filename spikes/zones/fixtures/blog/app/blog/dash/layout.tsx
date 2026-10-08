/* Parallel routes: the @stats slot renders beside the page. */
export default function DashLayout({ children, stats }: { children: React.ReactNode; stats: React.ReactNode }) {
  return <div>{children}<aside id="stats">{stats}</aside></div>;
}

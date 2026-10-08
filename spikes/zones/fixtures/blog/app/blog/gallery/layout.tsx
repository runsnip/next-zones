/* Intercepting routes: a photo opened from the gallery shows in the @modal slot; loaded directly, it is a full page. */
export default function GalleryLayout({ children, modal }: { children: React.ReactNode; modal: React.ReactNode }) {
  return <div>{children}{modal}</div>;
}

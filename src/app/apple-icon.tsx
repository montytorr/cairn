import { ImageResponse } from 'next/og'

// iOS ignores SVG favicons and wants a raster for the home screen, so the
// same cairn is drawn again at 180px rather than shipping a binary asset.
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

const Stone = ({ width, bottom }: { width: number; bottom: number }) => (
  <div
    style={{
      position: 'absolute',
      bottom,
      width,
      height: 31,
      borderRadius: 16,
      background: '#f7f8f8',
    }}
  />
)

const AppleIcon = () =>
  new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          position: 'relative',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#5e6ad2',
        }}
      >
        <Stone width={112} bottom={30} />
        <Stone width={84} bottom={72} />
        <Stone width={56} bottom={114} />
      </div>
    ),
    size,
  )

export default AppleIcon

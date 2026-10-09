interface Window {
  documentPictureInPicture?: {
    readonly window: Window | null
    requestWindow(options?: { width: number; height: number }): Promise<Window>
  }
}

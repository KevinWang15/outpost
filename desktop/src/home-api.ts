export interface HomeStatus {
  version: string
  servers: string[]
}
export interface HomeBridge {
  status(): Promise<HomeStatus>
  openServer(origin: string): Promise<boolean>
  forgetServer(origin: string): Promise<void>
  checkUpdates(): Promise<void>
}

import { describe, expect, it } from 'vitest'
import { detectPlatform } from './index'

describe('detectPlatform', () => {
  it('aceita só as plataformas permitidas', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=x')).toBe('youtube')
    expect(detectPlatform('https://youtu.be/x')).toBe('youtube')
    expect(detectPlatform('https://vm.tiktok.com/abc')).toBe('tiktok')
    expect(detectPlatform('https://www.instagram.com/reel/x')).toBe('instagram')
    expect(detectPlatform('https://youtube.com.evil.test/x')).toBeNull()
    expect(detectPlatform('file:///etc/passwd')).toBeNull()
    expect(detectPlatform('--exec rm')).toBeNull()
  })
})

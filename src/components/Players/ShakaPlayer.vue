<template>
  <component
    :is="mediaElement"
    ref="shakaPlayer"
    :poster="poster.url"
    autoplay
    crossorigin="anonymous"
    :playsinline="$browser.isMobile() && $browser.isApple()"
    @timeupdate="onProgressThrottled"
    @pause="onPause"
    @play="onPlay"
    @ended="onStopped"
  />
</template>

<script lang="ts">
import Vue from 'vue';
import { stringify } from 'qs';
import throttle from 'lodash/throttle';
// @ts-expect-error - This module doesn't have typings
import muxjs from 'mux.js';
import { mapActions, mapGetters, mapState } from 'vuex';
import { PlaybackInfoResponse, RepeatMode } from '@jellyfin/client-axios';
import { AppState } from '~/store';
import timeUtils from '~/mixins/timeUtils';
import imageHelper, { ImageUrlInfo } from '~/mixins/imageHelper';

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    muxjs: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    player: any;
  }
}

export default Vue.extend({
  mixins: [imageHelper, timeUtils],
  data() {
    return {
      playbackInfo: {} as PlaybackInfoResponse,
      source: '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      player: null as any,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      unsubscribe(): void {},
      audioContext: null as AudioContext | null,
      audioSource: null as MediaElementAudioSourceNode | null,
      gainNode: null as GainNode | null
    };
  },
  computed: {
    ...mapGetters('playbackManager', [
      'getCurrentItem',
      'getCurrentlyPlayingMediaType'
    ]),
    ...mapState('playbackManager', [
      'lastProgressUpdate',
      'currentTime',
      'currentVolume',
      'currentMediaSource',
      'currentVideoStreamIndex',
      'currentAudioStreamIndex',
      'currentSubtitleStreamIndex',
      'isMinimized'
    ]),
    ...mapState('deviceProfile', ['deviceId']),
    ...mapState('user', ['accessToken']),
    poster(): ImageUrlInfo | string {
      if (this.getCurrentlyPlayingMediaType === 'Video') {
        return this.getImageInfo(this.getCurrentItem, { preferBackdrop: true });
      } else {
        return '';
      }
    },
    mediaElement(): string {
      if (this.getCurrentlyPlayingMediaType === 'Audio') {
        return 'audio';
      } else if (this.getCurrentlyPlayingMediaType === 'Video') {
        return 'video';
      } else {
        return '';
      }
    }
  },
  watch: {
    getCurrentItem(): void {
      this.getPlaybackUrl();
    },
    async source(newSource): Promise<void> {
      if (this.player) {
        try {
          await this.player.load(newSource);
        } catch (e) {
          // No need to actually process the error here, the error handler will do this for us
        }
      }
    }
  },
  async mounted() {
    try {
      // Mux.js needs to be globally available before Shaka is loaded, in order for MPEG2 TS transmuxing to work.
      window.muxjs = muxjs;

      const { default: shaka } = await import(
        // @ts-expect-error - This module doesn't have typings
        'shaka-player/dist/shaka-player.compiled'
      );

      this.getPlaybackUrl();

      shaka.polyfill.installAll();

      if (shaka.Player.isBrowserSupported()) {
        // We use a global for ease of debugging and to fetch data from the playback information popup
        window.player = new shaka.Player(this.$refs.shakaPlayer);
        this.player = window.player;

        // Create WebAudio context and nodes for added processing
        this.audioContext = new AudioContext();
        this.audioSource = this.audioContext.createMediaElementSource(
          this.$refs.shakaPlayer as HTMLMediaElement
        );
        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.value = 1;
        this.audioSource.connect(this.gainNode);

        this.gainNode.connect(this.audioContext.destination);

        const updateVolume = (): void => {
          if (this.$refs.shakaPlayer && this.gainNode) {
            this.gainNode.gain.value = Math.pow(this.currentVolume / 100, 3);
          }
        };

        updateVolume();

        // Register player events
        this.player.addEventListener('error', this.onPlayerError);
        // Subscribe to Vuex actions
        this.unsubscribe = this.$store.subscribe(
          (mutation, _state: AppState) => {
            switch (mutation.type) {
              case 'playbackManager/PAUSE_PLAYBACK':
                if (this.$refs.shakaPlayer) {
                  (this.$refs.shakaPlayer as HTMLMediaElement).pause();
                }

                break;
              case 'playbackManager/UNPAUSE_PLAYBACK':
                if (this.$refs.shakaPlayer) {
                  (this.$refs.shakaPlayer as HTMLMediaElement).play();
                }

                break;
              case 'playbackManager/CHANGE_CURRENT_TIME':
                if (
                  this.$refs.shakaPlayer &&
                  mutation?.payload?.time !== null
                ) {
                  (this.$refs.shakaPlayer as HTMLMediaElement).currentTime =
                    mutation?.payload?.time;
                }

                break;

              case 'playbackManager/SET_VOLUME':
                updateVolume();

                break;

              case 'playbackManager/SET_REPEAT_MODE':
                if (this.$refs.shakaPlayer) {
                  if (mutation?.payload?.mode === RepeatMode.RepeatOne) {
                    (this.$refs.shakaPlayer as HTMLMediaElement).loop = true;
                  } else {
                    (this.$refs.shakaPlayer as HTMLMediaElement).loop = false;
                  }
                }
            }
          }
        );
      } else {
        this.$nuxt.error({
          message: this.$t('browserNotSupported')
        });
      }
    } catch (error) {
      this.$nuxt.error({
        statusCode: 404,
        message: error as string
      });
    }
  },
  beforeDestroy() {
    if (this.player) {
      window.muxjs = undefined;
      window.player = undefined;
      this.onStopped(); // Report that the playback is stopping
      this.player.removeEventListener('error', this.onPlayerError);
      this.player.unload();
      this.player.destroy();

      if (this.audioContext) {
        this.audioContext.close();
      }
    }

    this.unsubscribe();
  },
  methods: {
    ...mapActions('snackbar', ['pushSnackbarMessage']),
    ...mapActions('playbackManager', [
      'pause',
      'unpause',
      'setNextTrack',
      'setMediaSource',
      'setCurrentTime',
      'setPlaySessionId',
      'setLastProgressUpdate'
    ]),
    async getPlaybackUrl(): Promise<void> {
      if (this.getCurrentItem) {
        this.playbackInfo = (
          await this.$api.mediaInfo.getPostedPlaybackInfo(
            {
              itemId: this.getCurrentItem?.Id || '',
              userId: this.$auth.user?.Id,
              autoOpenLiveStream: true,
              playbackInfoDto: { DeviceProfile: this.$playbackProfile },
              mediaSourceId: this.currentMediaSource?.Id
                ? this.currentMediaSource.Id
                : undefined,
              audioStreamIndex: this.currentAudioStreamIndex,
              subtitleStreamIndex: this.currentSubtitleStreamIndex
            },
            { progress: false }
          )
        ).data;

        this.setPlaySessionId({ id: this.playbackInfo.PlaySessionId });

        let mediaSource;

        if (this.playbackInfo?.MediaSources) {
          mediaSource = this.playbackInfo.MediaSources[0];
          this.setMediaSource({ mediaSource });
        } else {
          throw new Error("This item can't be played.");
        }

        if (mediaSource.SupportsDirectStream) {
          const directOptions: Record<
            string,
            string | boolean | undefined | null
          > = {
            Static: true,
            mediaSourceId: mediaSource.Id,
            deviceId: this.deviceId,
            api_key: this.accessToken
          };

          if (mediaSource.ETag) {
            directOptions.Tag = mediaSource.ETag;
          }

          if (mediaSource.LiveStreamId) {
            directOptions.LiveStreamId = mediaSource.LiveStreamId;
          }

          const params = stringify(directOptions);

          let mediaType = 'Videos';

          if (this.getCurrentlyPlayingMediaType === 'Audio') {
            mediaType = 'Audio';
          }

          this.source = `${this.$axios.defaults.baseURL}/${mediaType}/${mediaSource.Id}/stream.${mediaSource.Container}?${params}`;
        } else if (
          mediaSource.SupportsTranscoding &&
          mediaSource.TranscodingUrl
        ) {
          this.source =
            this.$axios.defaults.baseURL + mediaSource.TranscodingUrl;
        }
      }
    },
    onPlay(_event?: Event): void {
      this.unpause();
    },
    onProgressThrottled: throttle(function (_event?: Event) {
      // @ts-expect-error - TypeScript is confusing the typings with lodash's
      this.onProgress(_event);
    }, 500),
    onProgress(_event?: Event): void {
      if (this.$refs.shakaPlayer) {
        const currentTime = (this.$refs.shakaPlayer as HTMLMediaElement)
          .currentTime;

        this.setCurrentTime({ time: currentTime });
      }
    },
    onPause(_event?: Event): void {
      if (this.$refs.shakaPlayer) {
        const currentTime = (this.$refs.shakaPlayer as HTMLMediaElement)
          .currentTime;

        this.setCurrentTime({ time: currentTime });
        this.pause();
      }
    },
    onStopped(_event?: Event): void {
      if (this.$refs.shakaPlayer) {
        const currentTime = (this.$refs.shakaPlayer as HTMLMediaElement)
          .currentTime;

        this.setCurrentTime({ time: currentTime });
        this.setNextTrack();
      }
    },
    onPlayerError(event: ErrorEvent): void {
      this.$emit('error', event);
    },
    togglePictureInPicture(): void {
      // @ts-expect-error - `requestPictureInPicture` does not exist in relevant types
      (this.$refs.shakaPlayer as HTMLMediaElement).requestPictureInPicture();
    }
  }
});
</script>

<style scoped>
.shaka-video-container,
video {
  max-width: 100vw;
  max-height: 100vh;
  width: 100%;
  height: 100%;
}
</style>

import { ActionTree } from 'vuex';
import { UserDto } from '@jellyfin/client-axios';
// Modules
import { TvShowsState } from './tvShows';
import { ServerState } from './servers';
import { PageState } from './page';
import { SnackbarState } from './snackbar';
import { UserState } from './user';
import { UserViewsState } from './userViews';
import { HomeSectionState } from './homeSection';
import { PlaybackManagerState } from './playbackManager';
import { BackdropState } from './backdrop';
import { DeviceState } from './deviceProfile';
import { ClientSettingsState } from './clientSettings';
import { ItemsState } from './items';
import { SocketState } from './socket';
import { TaskManagerState } from './taskManager';
// Vuex plugins
import { websocketPlugin } from './plugins/websocketPlugin';
import { playbackReportingPlugin } from './plugins/playbackReportingPlugin';
import { preferencesSync } from './plugins/preferencesSyncPlugin';
import { userPlugin } from './plugins/userPlugin';

export const plugins = [
  websocketPlugin,
  playbackReportingPlugin,
  preferencesSync,
  userPlugin
];

export interface AuthState {
  busy: boolean;
  loggedIn: boolean;
  rememberMe: boolean;
  strategy: string;
  user: UserDto;
}

export interface AppState {
  auth: AuthState;
  backdrop: BackdropState;
  clientSettings: ClientSettingsState;
  deviceProfile: DeviceState;
  homeSection: HomeSectionState;
  items: ItemsState;
  page: PageState;
  playbackManager: PlaybackManagerState;
  servers: ServerState;
  snackBar: SnackbarState;
  tvShows: TvShowsState;
  user: UserState;
  userViews: UserViewsState;
  socket: SocketState;
  taskManager: TaskManagerState;
}

export const actions: ActionTree<AppState, AppState> = {
  async reset({ dispatch }, { clearCritical }: { clearCritical: boolean }) {
    const promises = [];

    promises.push(dispatch('backdrop/clearAllBackdrop', { root: true }));
    promises.push(dispatch('clientSettings/resetState', { root: true }));
    promises.push(dispatch('homeSection/clearHomeSection', { root: true }));
    promises.push(dispatch('items/clearState', { root: true }));
    promises.push(dispatch('page/clearPage', { root: true }));
    promises.push(dispatch('playbackManager/stop', { root: true }));
    promises.push(dispatch('snackbar/resetMessage', { root: true }));
    promises.push(dispatch('tvShows/clearTvShows', { root: true }));
    promises.push(dispatch('user/clearUser', { root: true }));
    promises.push(dispatch('userViews/clearUserViews', { root: true }));
    promises.push(dispatch('socket/closeSocket', { root: true }));
    promises.push(dispatch('taskManager/reset'), { root: true });

    if (clearCritical) {
      promises.push(dispatch('servers/clearServers', { root: true }));
    }

    await Promise.all(promises);
  }
};

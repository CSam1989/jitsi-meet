import { batch } from 'react-redux';

import { IStore } from '../../app/types';
import { _RESET_BREAKOUT_ROOMS } from '../../breakout-rooms/actionTypes';
import { hideNotification } from '../../notifications/actions';
import { isPrejoinPageVisible } from '../../prejoin/functions';
import { getCurrentConference } from '../conference/functions';
import { getMultipleVideoSendingSupportFeatureFlag } from '../config/functions.any';
import { getAvailableDevices } from '../devices/actions';
import {
    SET_AUDIO_MUTED,
    SET_CAMERA_FACING_MODE,
    SET_SCREENSHARE_MUTED,
    SET_VIDEO_MUTED,
    TOGGLE_CAMERA_FACING_MODE
} from '../media/actionTypes';
import { setScreenshareMuted, toggleCameraFacingMode } from '../media/actions';
import {
    CAMERA_FACING_MODE,
    MEDIA_TYPE,
    MediaType,
    SCREENSHARE_MUTISM_AUTHORITY,
    VIDEO_MUTISM_AUTHORITY,
    VIDEO_TYPE
} from '../media/constants';
import MiddlewareRegistry from '../redux/MiddlewareRegistry';
import StateListenerRegistry from '../redux/StateListenerRegistry';

import {
    TRACK_ADDED,
    TRACK_MUTE_UNMUTE_FAILED,
    TRACK_NO_DATA_FROM_SOURCE,
    TRACK_REMOVED,
    TRACK_STOPPED,
    TRACK_UPDATED
} from './actionTypes';
import {
    createLocalTracksA,
    destroyLocalTracks,
    showNoDataFromSourceVideoError,
    toggleScreensharing,
    trackMuteUnmuteFailed,
    trackNoDataFromSourceNotificationInfoChanged,
    trackRemoved

    // @ts-ignore
} from './actions';
import {
    getLocalTrack,
    getTrackByJitsiTrack,
    isUserInteractionRequiredForUnmute,
    setTrackMuted
} from './functions';
import { ITrack } from './reducer';

import './subscriber';

/**
 * Middleware that captures LIB_DID_DISPOSE and LIB_DID_INIT actions and,
 * respectively, creates/destroys local media tracks. Also listens to
 * media-related actions and performs corresponding operations with tracks.
 *
 * @param {Store} store - The redux store.
 * @returns {Function}
 */
MiddlewareRegistry.register(store => next => action => {
    switch (action.type) {
    case TRACK_ADDED: {
        const { local } = action.track;

        // The devices list needs to be refreshed when no initial video permissions
        // were granted and a local video track is added by umuting the video.
        if (local) {
            store.dispatch(getAvailableDevices());
        }

        break;
    }
    case TRACK_NO_DATA_FROM_SOURCE: {
        const result = next(action);

        _handleNoDataFromSourceErrors(store, action);

        return result;
    }

    case TRACK_REMOVED: {
        _removeNoDataFromSourceNotification(store, action.track);
        break;
    }
    case SET_AUDIO_MUTED:
        if (!action.muted
                && isUserInteractionRequiredForUnmute(store.getState())) {
            return;
        }

        _setMuted(store, action, MEDIA_TYPE.AUDIO);
        break;

    case SET_CAMERA_FACING_MODE: {
        // XXX The camera facing mode of a MediaStreamTrack can be specified
        // only at initialization time and then it can only be toggled. So in
        // order to set the camera facing mode, one may destroy the track and
        // then initialize a new instance with the new camera facing mode. But
        // that is inefficient on mobile at least so the following relies on the
        // fact that there are 2 camera facing modes and merely toggles between
        // them to (hopefully) get the camera in the specified state.
        const localTrack = _getLocalTrack(store, MEDIA_TYPE.VIDEO);
        let jitsiTrack;

        if (localTrack
                && (jitsiTrack = localTrack.jitsiTrack)
                && jitsiTrack.getCameraFacingMode()
                    !== action.cameraFacingMode) {
            store.dispatch(toggleCameraFacingMode());
        }
        break;
    }

    case SET_SCREENSHARE_MUTED:
        _setMuted(store, action, action.mediaType);
        break;

    case SET_VIDEO_MUTED:
        if (!action.muted
                && isUserInteractionRequiredForUnmute(store.getState())) {
            return;
        }

        _setMuted(store, action, action.mediaType);
        break;

    case TOGGLE_CAMERA_FACING_MODE: {
        const localTrack = _getLocalTrack(store, MEDIA_TYPE.VIDEO);
        let jitsiTrack;

        if (localTrack && (jitsiTrack = localTrack.jitsiTrack)) {
            // XXX MediaStreamTrack._switchCamera is a custom function
            // implemented in react-native-webrtc for video which switches
            // between the cameras via a native WebRTC library implementation
            // without making any changes to the track.
            jitsiTrack._switchCamera();

            // Don't mirror the video of the back/environment-facing camera.
            const mirror
                = jitsiTrack.getCameraFacingMode() === CAMERA_FACING_MODE.USER;

            store.dispatch({
                type: TRACK_UPDATED,
                track: {
                    jitsiTrack,
                    mirror
                }
            });
        }
        break;
    }

    case TRACK_MUTE_UNMUTE_FAILED: {
        const { jitsiTrack } = action.track;
        const muted = action.wasMuted;
        const isVideoTrack = jitsiTrack.getType() !== MEDIA_TYPE.AUDIO;

        if (typeof APP !== 'undefined') {
            if (isVideoTrack && jitsiTrack.getVideoType() === VIDEO_TYPE.DESKTOP
                && getMultipleVideoSendingSupportFeatureFlag(store.getState())) {
                store.dispatch(setScreenshareMuted(!muted));
            } else if (isVideoTrack) {
                APP.conference.setVideoMuteStatus();
            } else {
                APP.conference.setAudioMuteStatus(!muted);
            }
        }
        break;
    }

    case TRACK_STOPPED: {
        const { jitsiTrack } = action.track;

        if (typeof APP !== 'undefined'
            && getMultipleVideoSendingSupportFeatureFlag(store.getState())
            && jitsiTrack.getVideoType() === VIDEO_TYPE.DESKTOP) {
            store.dispatch(toggleScreensharing(false));
        }
        break;
    }

    case TRACK_UPDATED: {
        // TODO Remove the following calls to APP.UI once components interested
        // in track mute changes are moved into React and/or redux.
        if (typeof APP !== 'undefined') {
            const result = next(action);
            const state = store.getState();

            if (isPrejoinPageVisible(state)) {
                return result;
            }

            const { jitsiTrack } = action.track;
            const muted = jitsiTrack.isMuted();
            const participantID = jitsiTrack.getParticipantId();
            const isVideoTrack = jitsiTrack.type !== MEDIA_TYPE.AUDIO;

            if (isVideoTrack) {
                // Do not change the video mute state for local presenter tracks.
                if (jitsiTrack.type === MEDIA_TYPE.PRESENTER) {
                    APP.conference.mutePresenter(muted);
                } else if (jitsiTrack.isLocal() && !(jitsiTrack.getVideoType() === VIDEO_TYPE.DESKTOP)) {
                    APP.conference.setVideoMuteStatus();
                } else if (jitsiTrack.isLocal() && muted && jitsiTrack.getVideoType() === VIDEO_TYPE.DESKTOP) {
                    !getMultipleVideoSendingSupportFeatureFlag(state)
                        && store.dispatch(toggleScreensharing(false, false, true));
                } else {
                    APP.UI.setVideoMuted(participantID);
                }
            } else if (jitsiTrack.isLocal()) {
                APP.conference.setAudioMuteStatus(muted);
            } else {
                APP.UI.setAudioMuted(participantID, muted);
            }

            return result;
        }

        // Mobile.
        const { jitsiTrack, local } = action.track;

        if (local && jitsiTrack.isMuted()
                && jitsiTrack.type === MEDIA_TYPE.VIDEO && jitsiTrack.videoType === VIDEO_TYPE.DESKTOP) {
            store.dispatch(toggleScreensharing(false));
        }
        break;
    }
    }

    return next(action);
});

/**
 * Set up state change listener to perform maintenance tasks when the conference
 * is left or failed, remove all tracks from the store.
 */
StateListenerRegistry.register(
    state => getCurrentConference(state),
    (conference, { dispatch, getState }, prevConference) => {
        const { authRequired, error } = getState()['features/base/conference'];

        // conference keep flipping while we are authenticating, skip clearing while we are in that process
        if (prevConference && !conference && !authRequired && !error) {

            // Clear all tracks.
            const remoteTracks = getState()['features/base/tracks'].filter(t => !t.local);

            batch(() => {
                dispatch(destroyLocalTracks());
                for (const track of remoteTracks) {
                    dispatch(trackRemoved(track.jitsiTrack));
                }
                dispatch({ type: _RESET_BREAKOUT_ROOMS });
            });
        }
    });

/**
 * Handles no data from source errors.
 *
 * @param {Store} store - The redux store in which the specified action is
 * dispatched.
 * @param {Action} action - The redux action dispatched in the specified store.
 * @private
 * @returns {void}
 */
function _handleNoDataFromSourceErrors(store: IStore, action: any) {
    const { getState, dispatch } = store;

    const track = getTrackByJitsiTrack(getState()['features/base/tracks'], action.track.jitsiTrack);

    if (!track || !track.local) {
        return;
    }

    const { jitsiTrack } = track;

    if (track.mediaType === MEDIA_TYPE.AUDIO && track.isReceivingData) {
        _removeNoDataFromSourceNotification(store, action.track);
    }

    if (track.mediaType === MEDIA_TYPE.VIDEO) {
        const { noDataFromSourceNotificationInfo = {} } = track;

        if (track.isReceivingData) {
            if (noDataFromSourceNotificationInfo.timeout) {
                clearTimeout(noDataFromSourceNotificationInfo.timeout);
                dispatch(trackNoDataFromSourceNotificationInfoChanged(jitsiTrack, undefined));
            }

            // try to remove the notification if there is one.
            _removeNoDataFromSourceNotification(store, action.track);
        } else {
            if (noDataFromSourceNotificationInfo.timeout) {
                return;
            }

            const timeout = setTimeout(() => dispatch(showNoDataFromSourceVideoError(jitsiTrack)), 5000);

            dispatch(trackNoDataFromSourceNotificationInfoChanged(jitsiTrack, { timeout }));
        }
    }
}

/**
 * Gets the local track associated with a specific {@code MEDIA_TYPE} in a
 * specific redux store.
 *
 * @param {Store} store - The redux store from which the local track associated
 * with the specified {@code mediaType} is to be retrieved.
 * @param {MEDIA_TYPE} mediaType - The {@code MEDIA_TYPE} of the local track to
 * be retrieved from the specified {@code store}.
 * @param {boolean} [includePending] - Indicates whether a local track is to be
 * returned if it is still pending. A local track is pending if
 * {@code getUserMedia} is still executing to create it and, consequently, its
 * {@code jitsiTrack} property is {@code undefined}. By default a pending local
 * track is not returned.
 * @private
 * @returns {Track} The local {@code Track} associated with the specified
 * {@code mediaType} in the specified {@code store}.
 */
function _getLocalTrack(
        { getState }: { getState: Function; },
        mediaType: MediaType,
        includePending = false) {
    return (
        getLocalTrack(
            getState()['features/base/tracks'],
            mediaType,
            includePending));
}

/**
 * Removes the no data from source notification associated with the JitsiTrack if displayed.
 *
 * @param {Store} store - The redux store.
 * @param {Track} track - The redux action dispatched in the specified store.
 * @returns {void}
 */
function _removeNoDataFromSourceNotification({ getState, dispatch }: IStore, track: ITrack) {
    const t = getTrackByJitsiTrack(getState()['features/base/tracks'], track.jitsiTrack);
    const { jitsiTrack, noDataFromSourceNotificationInfo = {} } = t || {};

    if (noDataFromSourceNotificationInfo?.uid) {
        dispatch(hideNotification(noDataFromSourceNotificationInfo.uid));
        dispatch(trackNoDataFromSourceNotificationInfoChanged(jitsiTrack, undefined));
    }
}

/**
 * Mutes or unmutes a local track with a specific media type.
 *
 * @param {Store} store - The redux store in which the specified action is
 * dispatched.
 * @param {Action} action - The redux action dispatched in the specified store.
 * @param {MEDIA_TYPE} mediaType - The {@link MEDIA_TYPE} of the local track
 * which is being muted or unmuted.
 * @private
 * @returns {void}
 */
async function _setMuted(store: IStore, { ensureTrack, authority, muted }: {
    authority: number; ensureTrack: boolean; muted: boolean; }, mediaType: MediaType) {
    const { dispatch, getState } = store;
    const localTrack = _getLocalTrack(store, mediaType, /* includePending */ true);
    const state = getState();

    if (mediaType === MEDIA_TYPE.SCREENSHARE
        && getMultipleVideoSendingSupportFeatureFlag(state)
        && !muted) {
        return;
    }

    if (localTrack) {
        // The `jitsiTrack` property will have a value only for a localTrack for which `getUserMedia` has already
        // completed. If there's no `jitsiTrack`, then the `muted` state will be applied once the `jitsiTrack` is
        // created.
        const { jitsiTrack } = localTrack;
        const isAudioOnly = (mediaType === MEDIA_TYPE.VIDEO && authority === VIDEO_MUTISM_AUTHORITY.AUDIO_ONLY)
            || (mediaType === MEDIA_TYPE.SCREENSHARE && authority === SCREENSHARE_MUTISM_AUTHORITY.AUDIO_ONLY);

        // Screenshare cannot be unmuted using the video mute button unless it is muted by audioOnly in the legacy
        // screensharing mode.
        if (jitsiTrack && (
            jitsiTrack.videoType !== 'desktop' || isAudioOnly || getMultipleVideoSendingSupportFeatureFlag(state))
        ) {
            setTrackMuted(jitsiTrack, muted, state).catch(() => dispatch(trackMuteUnmuteFailed(localTrack, muted)));
        }
    } else if (!muted && ensureTrack && (typeof APP === 'undefined' || isPrejoinPageVisible(state))) {
        // FIXME: This only runs on mobile now because web has its own way of
        // creating local tracks. Adjust the check once they are unified.
        dispatch(createLocalTracksA({ devices: [ mediaType ] }));
    }
}

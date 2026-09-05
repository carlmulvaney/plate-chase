import 'server-only'

/**
 * The image pipeline, behind the server-only guard the app should use.
 *
 * The implementation is in ./image-pipeline so scripts can import it without
 * Next; this file exists so an accidental client import is a build error
 * rather than sharp in a browser bundle.
 */
export { buildDisplayImage, isHeicBytes, type Derivative } from './image-pipeline'

import {DocHandle, Repo, AutomergeUrl, isValidAutomergeUrl} from '@automerge/automerge-repo'
import {BlockData as BlockData, BlockPropertyValue} from '@/types.ts'
import {ChangeOptions as AutomergeCahngeOptions} from '@automerge/automerge'
import {createBlockDoc} from '@/utils/block-operations.ts'
import {useDocument} from '@automerge/automerge-repo-react-hooks'

export type ChangeFn<T> = (doc: T) => void;
export type ChangeOptions<T> = AutomergeCahngeOptions<T>

/**
 * I want to abstract away the details of the storage lay away from the component, so i can plug in jazz.tools or similar later
 */
export class Block {
    static async new(repo: Repo, data: Partial<BlockData>) {
        const doc = createBlockDoc(repo, data)
        return new Block(repo, doc.url)
    }

    id: AutomergeUrl
    handle: DocHandle<BlockData>

    constructor(readonly repo: Repo, id: string) {
        if (!isValidAutomergeUrl(id)) throw new Error('Invalid block id')

        this.id = id
        this.handle = repo.find<BlockData>(id)
    }


    change(callback: ChangeFn<BlockData>, options: ChangeOptions<BlockData> = {}) {
        this.handle.change(callback, options)
    }

    outdent() {
    }

    indent() {
    }

    async createSiblingBelow(data: Partial<BlockData>) {
        const doc = await this.handle.doc()
        if (!doc) throw new Error(`Block not found: ${this.id}`)
        if (!doc.parentId) throw new Error('Cannot create sibling for top-level block')

        const newBlock = createBlockDoc(this.repo, {
            ...data,
            parentId: doc.parentId,
        })

        // Insert the new block after this one in the parent's childIds
        const parent = this.repo.find<BlockData>(doc.parentId as AutomergeUrl)
        parent.change(parent => {
            const index = parent.childIds.indexOf(this.id)
            parent.childIds.splice(index + 1, 0, newBlock.url)
        })

        return new Block(this.repo, newBlock.url)
    }

    use() {
        return useDocument<BlockData>(this.id)[0]
    }

    useProperty<T extends BlockPropertyValue>(name: string): [T | undefined, (value: T) => void];
    useProperty<T extends BlockPropertyValue>(name: string, initialValue: T): [T, (value: T) => void];
    useProperty<T extends BlockPropertyValue>(name: string, initialValue?: T) {
        const doc = this.use()
        const value = (doc?.properties[name] ?? initialValue) as T | undefined

        const setValue = (newValue: T) => {
            this.change(doc => doc.properties[name] = newValue)
        }

        return [value, setValue]
    }
}

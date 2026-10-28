package com.miranotes.app;
import static org.junit.Assert.*;
import android.util.Base64;
import org.junit.*;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import org.robolectric.android.controller.ActivityController;
import java.io.*;
import java.nio.file.Files;
import java.util.Arrays;
@RunWith(RobolectricTestRunner.class) @Config(manifest=Config.NONE,sdk=35)
public class BackupTest {
    @Rule public TemporaryFolder temporary=new TemporaryFolder();
    @Test public void binaryChunksRetainEveryByteAndTemporaryFileIsAppOwned() throws Exception {
        File cache=temporary.newFolder(); byte[] bytes=new byte[140001]; for(int i=0;i<bytes.length;i++) bytes[i]=(byte)i;
        try(BackupTransfer transfer=new BackupTransfer(cache)) {
            String id=transfer.start("NoteMark-backup-2026-10-19.zip","application/zip").getString("transfer"); int sequence=0;
            for(int p=0;p<bytes.length;p+=65536) transfer.chunk(id,sequence++,Base64.encodeToString(Arrays.copyOfRange(bytes,p,Math.min(p+65536,bytes.length)),Base64.NO_WRAP));
            BackupTransfer.Finished done=transfer.finish(id); assertEquals(cache.getCanonicalFile(),done.file.getParentFile().getCanonicalFile());
            assertArrayEquals(bytes,Files.readAllBytes(done.file.toPath())); assertTrue(done.file.delete());
        }
    }
    @Test public void invalidNamesOversizedChunksAndWrongSequencesAreRejectedAndCancellationCleansUp() throws Exception {
        File cache=temporary.newFolder(); try(BackupTransfer t=new BackupTransfer(cache)) {
            try { t.start("../escape.zip","application/zip"); fail(); } catch(IOException expected){}
            String id=t.start("NoteMark-backup-test.zip","application/zip").getString("transfer");
            for(int sequence:new int[]{1,-1}) try{t.chunk(id,sequence,"AQID");fail();}catch(IOException expected){}
            try{t.chunk(id,0,Base64.encodeToString(new byte[65537],Base64.NO_WRAP));fail();}catch(IOException expected){}
            t.chunk(id,0,"AAECAw=="); t.cancel(id); assertEquals(0,cache.list().length);
            String second=t.start("NoteMark-recovery-test.json","application/json").getString("transfer"); t.chunk(second,0,"e30=");
        } assertEquals(0,cache.list().length);
    }
    @Test public void cancellingDocumentPickerRemovesTemporaryZipAndPreservesNotebookFiles() throws Exception {
        android.content.Context app=RuntimeEnvironment.getApplication();
        File zip=File.createTempFile("notemark-export-",".tmp",app.getCacheDir()); Files.write(zip.toPath(),new byte[]{0,1,2,(byte)255});
        android.content.Intent intent=new android.content.Intent(app,BackupSaveActivity.class).putExtra("temporaryName",zip.getName()).putExtra("name","NoteMark-backup-test.zip").putExtra("mime","application/zip");
        try(ActivityController<BackupSaveActivity> c=Robolectric.buildActivity(BackupSaveActivity.class,intent)) {
            BackupSaveActivity a=c.get(); a.setTheme(android.R.style.Theme_Material_Light_NoActionBar); c.create().start().resume().visible();
            File marker=new File(a.getFilesDir(),"backup-preservation-marker"); Files.writeString(marker.toPath(),"Existing notebook");
            android.content.Intent picker=Shadows.shadowOf(a).getNextStartedActivityForResult().intent;
            assertEquals(android.content.Intent.ACTION_CREATE_DOCUMENT,picker.getAction()); assertEquals("application/zip",picker.getType());
            a.onActivityResult(BackupSaveActivity.SAVE_BACKUP,android.app.Activity.RESULT_CANCELED,null);
            assertFalse(zip.exists()); assertEquals("Existing notebook",Files.readString(marker.toPath()));
        }
    }
}
